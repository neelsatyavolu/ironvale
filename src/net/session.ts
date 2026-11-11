import type { GameContext, MatchConfig } from '../game/contracts';
import type { MapInstance, SpawnPoint } from '../world/types';
import {
  DEFAULT_NET_CONFIG,
  type LobbyState,
  type NetErrorCode,
  type NetGameHooks,
  type NetMatchConfig,
  type NetMethod,
  type NetNotice,
  type NetPartner,
  type NetRole,
  type NetSnapshot,
  type NetSystem,
} from './api';
import { ClockSync } from './clock';
import { fetchRelayServers, iceServers } from './ice';
import { sanitizeName } from './limits';
import { MatchSync, type MatchLink } from './match';
import {
  MAX_KILL_TARGET,
  MAX_NET_BOTS,
  PROTOCOL_VERSION,
  decodeBinary,
  encodeEvent,
  encodePing,
  encodePong,
  parseEvent,
  type ByeReason,
  type NetEvent,
} from './protocol';
import { pickDuelSpawn } from './rules';
import { ManualSignaling, RoomSignaling, signalReachable, signalUrl, type SignalHandlers, type Signaling } from './signaling';
import { PeerLink } from './transport';

const NAME_KEY = 'ironvale.net.v1';
const COUNTDOWN_MS = 3000;
/** In a match, this long without state from the other player means they are gone. */
const PEER_TIMEOUT_MS = 5000;
/** How long the direct connection may take once both sides have what they need. */
const CONNECT_TIMEOUT_MS = 25_000;
const PING_FAST_MS = 250;
const PING_SLOW_MS = 1000;
const PING_FAST_COUNT = 8;
const REACHABLE_CACHE_MS = 10_000;
const MATCH_REPORT_MS = 500;
const MAX_QUEUED_EVENTS = 256;
/** Capsule the size of the player, for checking a spot beside a shared spawn. */
const BODY_RADIUS = 0.34;
const BODY_HEIGHT = 1.8;
const SIDE_STEP = 1.6;
/** Errors from a pasted code that leave the host's invite usable. */
const PASTE_ERRORS: readonly NetErrorCode[] = ['bad-code', 'wrong-code-kind', 'code-too-long'];

function readName(): string {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(NAME_KEY) ?? 'null');
    if (typeof stored === 'object' && stored !== null) return sanitizeName((stored as { name?: unknown }).name);
  } catch {
    // Blocked storage or an old value: fall through to the default.
  }
  return 'Player';
}

function clampWhole(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min;
}

/** The two-player session: the lobby, the connection and the running match. */
export class NetSession implements NetSystem {
  private lobby: LobbyState;
  private readonly listeners = new Set<(state: LobbyState) => void>();
  private readonly clock = new ClockSync();
  private readonly abort = new AbortController();
  private signaling: Signaling | null = null;
  private link: PeerLink | null = null;
  /** Relay servers for this attempt, from the signaling service. */
  private relayServers: RTCIceServer[] = [];
  private sync: MatchSync | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private reachable: { at: number; value: Promise<boolean> } | null = null;

  /** The two-player match that is loading or loaded, and the role it was started in. */
  private match: NetMatchConfig | null = null;
  private matchRole: NetRole = 'host';
  private beginning = false;
  private localLoaded = false;
  private peerLoaded = false;
  /** Local clock time the match starts; infinite until both have loaded. */
  private goAt = Number.POSITIVE_INFINITY;
  private peerGone = false;
  private peerAway = false;
  private lossNotice: NetNotice | null = null;
  private queued: NetEvent[] = [];
  private pingId = 0;
  private pingsSent = 0;
  private nextPingAt = 0;
  private lastReportAt = 0;
  private lastReport = '';
  private rttShown = -1;

  private readonly matchLink: MatchLink;

  constructor(
    private readonly ctx: GameContext,
    private readonly hooks: NetGameHooks,
  ) {
    this.lobby = {
      step: 'idle',
      role: null,
      method: null,
      code: '',
      error: null,
      localName: readName(),
      peerName: 'Friend',
      localReady: false,
      peerReady: false,
      config: { ...DEFAULT_NET_CONFIG, mapId: hooks.listMaps()[0]?.id ?? '', difficulty: ctx.settings.value.gameplay.difficulty },
      rttMs: -1,
      inMatch: false,
    };
    this.matchLink = {
      clock: this.clock,
      sendState: (data) => this.link?.sendState(data),
      sendEvent: (event) => this.send(event),
      sendShot: (data) => void this.link?.sendEvent(data),
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => this.send({ t: 'away', away: document.hidden }), { signal: this.abort.signal });
      // Closing the tab should not leave the friend waiting for a timeout.
      window.addEventListener('pagehide', () => this.send({ t: 'bye', reason: 'left' }), { signal: this.abort.signal });
    }
  }

  // ---------------------------------------------------------------- lobby

  get state(): LobbyState {
    return this.lobby;
  }

  subscribe(listener: (state: LobbyState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  roomCodesAvailable(): Promise<boolean> {
    const now = performance.now();
    if (this.reachable && now - this.reachable.at < REACHABLE_CACHE_MS) return this.reachable.value;
    const value = signalReachable(signalUrl());
    this.reachable = { at: now, value };
    return value;
  }

  host(method: NetMethod): void {
    this.open('host', method, '');
  }

  join(method: NetMethod, code: string): void {
    this.open('guest', method, code);
  }

  acceptReply(code: string): void {
    if (this.lobby.role !== 'host' || this.lobby.method !== 'manual') return;
    this.patch({ error: null });
    this.signaling?.paste(code);
  }

  setConfig(patch: Partial<NetMatchConfig>): void {
    if (this.lobby.role === 'guest') return;
    const merged = { ...this.lobby.config, ...patch };
    const config: NetMatchConfig = {
      ...merged,
      botCount: clampWhole(merged.botCount, 1, MAX_NET_BOTS),
      killTarget: clampWhole(merged.killTarget, 1, MAX_KILL_TARGET),
    };
    this.patch({ config });
    if (this.lobby.step === 'connected') this.send({ t: 'lobby', config });
  }

  setReady(ready: boolean): void {
    if (this.lobby.role !== 'guest' || this.lobby.step !== 'connected') return;
    this.patch({ localReady: ready });
    this.send({ t: 'ready', ready });
  }

  start(): void {
    const { role, step, peerReady, config } = this.lobby;
    if (role !== 'host' || step !== 'connected' || !peerReady || this.match) return;
    if (!this.knownMap(config.mapId)) {
      this.patch({ error: 'unknown-map' });
      return;
    }
    this.send({ t: 'load', config });
    this.beginMatch(config);
  }

  leave(): void {
    this.send({ t: 'bye', reason: 'left' });
    this.closeConnection();
    this.patch({ step: 'idle', role: null, method: null, code: '', error: null, peerReady: false, localReady: false, inMatch: false });
    if (this.match && !this.peerGone) {
      // Leaving mid-match: the game that keeps running here is on its own.
      this.peerGone = true;
      this.sync?.dropRemote();
    }
  }

  setName(name: string): void {
    const localName = sanitizeName(name);
    if (localName === this.lobby.localName) return;
    try {
      localStorage.setItem(NAME_KEY, JSON.stringify({ name: localName }));
    } catch (error) {
      console.warn('Could not save the player name', error);
    }
    this.patch({ localName });
    if (this.lobby.step === 'connected') this.send({ t: 'hello', v: PROTOCOL_VERSION, name: localName });
  }

  private patch(change: Partial<LobbyState>): void {
    this.lobby = { ...this.lobby, ...change };
    for (const listener of [...this.listeners]) listener(this.lobby);
  }

  private knownMap(id: string): boolean {
    // The developer test map is not in the menu but is fine to play on.
    return this.hooks.listMaps().some((map) => map.id === id) || (import.meta.env.DEV && id === 'range');
  }

  // ---------------------------------------------------------------- connecting

  private open(role: NetRole, method: NetMethod, code: string): void {
    this.closeConnection();
    this.patch({ step: 'opening', role, method, code: '', error: null, peerReady: false, localReady: role === 'host', rttMs: -1 });
    const signaling: Signaling = method === 'room' ? new RoomSignaling(signalUrl()) : new ManualSignaling();
    this.signaling = signaling;
    const handlers: SignalHandlers = {
      onCode: (text) => {
        if (this.signaling !== signaling) return;
        this.patch({ code: text, step: role === 'host' ? 'waiting' : 'reply' });
      },
      onPeer: (present) => {
        if (this.signaling !== signaling) return;
        if (role === 'guest') {
          if (present) this.patch({ step: 'connecting' });
          return;
        }
        if (!present) {
          // The friend closed the page before connecting: wait for them to come back.
          this.dropLink();
          this.patch({ step: 'waiting' });
          return;
        }
        this.makeLink(signaling)
          .makeOffer()
          .catch((error: unknown) => this.connectError(error));
      },
      onSignal: (message) => {
        if (this.signaling !== signaling) return;
        if (message.type === 'candidate') {
          void this.link?.addCandidate(message.candidate);
        } else if (message.type === 'offer' && role === 'guest') {
          this.makeLink(signaling)
            .acceptOffer(message.sdp, method === 'manual')
            .catch((error: unknown) => this.connectError(error));
          if (method === 'room') this.expectConnection();
        } else if (message.type === 'answer' && role === 'host' && this.link) {
          this.patch({ step: 'connecting', error: null });
          this.link.acceptAnswer(message.sdp).catch((error: unknown) => this.connectError(error));
          this.expectConnection();
        }
      },
      onError: (error) => {
        if (this.signaling !== signaling) return;
        // A wrong paste on the host's side does not spoil the invite: say so and let them try again.
        if (role === 'host' && method === 'manual' && PASTE_ERRORS.includes(error)) this.patch({ error });
        else this.fail(error);
      },
    };
    const base = signalUrl();
    if (!base) {
      signaling.open(role, code, handlers);
      return;
    }
    // Ask for relay servers first, so both sides have them before any offer is made.
    void fetchRelayServers(base).then((servers) => {
      if (this.signaling !== signaling) return;
      this.relayServers = servers;
      signaling.open(role, code, handlers);
    });
  }

  private makeLink(signaling: Signaling): PeerLink {
    this.dropLink();
    const link: PeerLink = new PeerLink(
      { iceServers: [...iceServers(), ...this.relayServers], trickle: signaling.trickle },
      {
        onOpen: () => {
          if (this.link === link) this.onConnected();
        },
        onState: (data) => {
          if (this.link === link) this.onBinary(data);
        },
        onEvent: (data) => {
          if (this.link !== link) return;
          if (typeof data === 'string') this.onEvent(data);
          else this.onBinary(data);
        },
        onClosed: () => {
          if (this.link !== link) return;
          if (this.lobby.step === 'connected') this.peerLost('left');
          else this.fail('connect-failed');
        },
        onSignal: (message) => {
          if (this.link === link) this.signaling?.send(message);
        },
      },
    );
    this.link = link;
    return link;
  }

  private connectError(error: unknown): void {
    console.warn('Could not set up the connection', error);
    this.fail('connect-failed');
  }

  private expectConnection(): void {
    this.clearConnectTimer();
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.lobby.step !== 'connected' && this.lobby.step !== 'idle') this.fail('connect-failed');
    }, CONNECT_TIMEOUT_MS);
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private onConnected(): void {
    this.clearConnectTimer();
    // The relay has done its job; the two machines talk directly from here.
    this.signaling?.close();
    this.signaling = null;
    this.clock.reset();
    this.pingsSent = 0;
    this.nextPingAt = 0;
    this.patch({ step: 'connected', error: null });
    this.send({ t: 'hello', v: PROTOCOL_VERSION, name: this.lobby.localName });
    if (this.lobby.role === 'host') this.send({ t: 'lobby', config: this.lobby.config });
  }

  private fail(error: NetErrorCode): void {
    this.closeConnection();
    this.patch({ step: 'idle', role: null, method: null, code: '', error, peerReady: false, localReady: false, inMatch: false });
    // A connection dropped mid-match leaves the match without its other player, whatever the cause.
    this.orphanMatch('peer-left');
  }

  private dropLink(): void {
    const link = this.link;
    this.link = null;
    link?.close();
  }

  private closeConnection(): void {
    this.clearConnectTimer();
    const signaling = this.signaling;
    this.signaling = null;
    signaling?.close();
    this.dropLink();
  }

  private send(event: NetEvent): void {
    this.link?.sendEvent(encodeEvent(event));
  }

  // ---------------------------------------------------------------- messages in

  private onBinary(data: ArrayBuffer): void {
    const message = decodeBinary(data);
    if (!message) return;
    const now = performance.now();
    if (message.type === 'ping') this.link?.sendState(encodePong(message.id, message.sentAt, now));
    else if (message.type === 'pong') this.clock.addSample(message.sentAt, message.remoteTime, now);
    else this.sync?.handleBinary(message, now);
  }

  private onEvent(text: string): void {
    const event = parseEvent(text);
    if (!event) return;
    const role = this.lobby.role;
    switch (event.t) {
      case 'hello':
        if (event.v !== PROTOCOL_VERSION) {
          this.send({ t: 'bye', reason: 'left' });
          this.fail('version');
          return;
        }
        this.patch({ peerName: event.name });
        if (this.sync) this.sync.remote.name = event.name;
        break;
      case 'lobby':
        if (role === 'guest' && !this.match) this.patch({ config: event.config });
        break;
      case 'ready':
        if (role === 'host') this.patch({ peerReady: event.ready });
        break;
      case 'load':
        // The host can only start once this guest has said it is ready; a repeat mid-match is ignored.
        if (role !== 'guest' || !this.lobby.localReady) break;
        if (!this.knownMap(event.config.mapId)) {
          this.send({ t: 'bye', reason: 'left' });
          this.fail('unknown-map');
          break;
        }
        this.patch({ config: event.config });
        this.beginMatch(event.config);
        break;
      case 'loaded':
        this.peerLoaded = true;
        this.maybeGo();
        break;
      case 'go':
        // Once per match: a later one could hold this player frozen while the other shoots.
        if (role === 'guest' && this.match && this.goAt === Number.POSITIVE_INFINITY) {
          const now = performance.now();
          this.goAt = Math.min(now + COUNTDOWN_MS * 3, Math.max(now, this.clock.toLocal(event.at)));
        }
        break;
      case 'away':
        this.peerAway = event.away;
        break;
      case 'bye':
        this.peerLost(event.reason === 'timeout' ? 'timeout' : 'left');
        break;
      default:
        if (this.sync) this.sync.handleEvent(event, performance.now());
        else if (this.match && this.queued.length < MAX_QUEUED_EVENTS) this.queued = [...this.queued, event];
        break;
    }
  }

  // ---------------------------------------------------------------- match

  get inMatch(): boolean {
    return this.match !== null && !this.peerGone && this.link !== null;
  }

  get authority(): boolean {
    return !(this.inMatch && this.matchRole === 'guest' && this.match?.mode === 'coop');
  }

  get frozen(): boolean {
    return this.inMatch && performance.now() < this.goAt;
  }

  get partner(): NetPartner | null {
    const sync = this.sync;
    if (!sync || !this.inMatch) return null;
    return { alive: sync.remote.alive, deaths: sync.partnerDeaths };
  }

  get partnerKills(): number {
    return this.sync?.partnerKills ?? 0;
  }

  get hostMatch(): { readonly wave: number; readonly enemies: number } | null {
    return this.authority ? null : (this.sync?.hostMatch ?? null);
  }

  snapshot(): NetSnapshot | null {
    const match = this.match;
    if (!match) return null;
    const now = performance.now();
    const waiting = !this.peerGone && this.goAt === Number.POSITIVE_INFINITY;
    return {
      role: this.matchRole,
      localName: this.lobby.localName,
      peerName: this.lobby.peerName,
      peerKills: match.mode === 'duel' ? this.hooks.deaths : this.partnerKills,
      killTarget: match.killTarget,
      peerConnected: !this.peerGone,
      countdown: this.peerGone || waiting ? 0 : Math.max(0, Math.ceil((this.goAt - now) / 1000)),
      notice: this.peerGone ? this.lossNotice : waiting ? 'waiting-peer' : this.peerAway ? 'peer-away' : null,
      rttMs: this.peerGone ? -1 : Math.round(this.clock.rtt),
    };
  }

  private beginMatch(config: NetMatchConfig): void {
    const role = this.lobby.role;
    if (!role) return;
    const matchConfig: MatchConfig = {
      mapId: config.mapId,
      mode: config.mode,
      difficulty: config.difficulty,
      botCount: config.mode === 'duel' ? 0 : config.botCount,
      rules: config.rules,
      killTarget: config.killTarget,
    };
    // `startMatch` unloads whatever was loaded before it returns its promise; set this match up after that.
    this.beginning = true;
    const loading = this.hooks.startMatch(matchConfig);
    this.beginning = false;
    this.match = config;
    this.matchRole = role;
    this.localLoaded = false;
    this.peerLoaded = false;
    this.goAt = Number.POSITIVE_INFINITY;
    this.peerGone = false;
    this.peerAway = false;
    this.lossNotice = null;
    this.queued = [];
    this.lastReport = '';
    this.patch({ inMatch: true, localReady: role === 'host', peerReady: false, error: null });
    loading.catch((error: unknown) => {
      console.error('Could not load the two-player match', error);
      if (this.match !== config) return;
      this.match = null;
      this.send({ t: 'bye', reason: 'left' });
      this.fail('load-failed');
    });
  }

  enterMap(_map: MapInstance): void {
    const match = this.match;
    if (!match || this.peerGone || !this.link) return;
    this.sync?.dispose();
    this.sync = new MatchSync({
      ctx: this.ctx,
      hooks: this.hooks,
      link: this.matchLink,
      role: this.matchRole,
      config: match,
      peerName: this.lobby.peerName,
    });
    const queued = this.queued;
    this.queued = [];
    const now = performance.now();
    for (const event of queued) this.sync.handleEvent(event, now);
  }

  matchLoaded(): void {
    if (!this.match) return;
    this.localLoaded = true;
    if (this.peerGone) {
      this.applyLoss();
      return;
    }
    this.send({ t: 'loaded' });
    this.maybeGo();
  }

  leaveMap(): void {
    this.sync?.dispose();
    this.sync = null;
    if (this.beginning || !this.match) return;
    this.match = null;
    this.queued = [];
    this.goAt = Number.POSITIVE_INFINITY;
    this.patch({ inMatch: false });
  }

  pickSpawn(map: MapInstance, initial: boolean): SpawnPoint | null {
    const match = this.match;
    if (!match || this.peerGone) return null;
    if (match.mode === 'duel') {
      const spawns = [...map.playerSpawns, ...map.enemySpawns];
      const first = spawns[0];
      if (!first) return null;
      if (initial && this.matchRole === 'host') return first;
      // The guest starts as far from the host's start as the map allows; after that, as far from the opponent.
      const opponent = initial || !this.sync ? first.position : this.sync.remote.position;
      return spawns[pickDuelSpawn(spawns.map((spawn) => spawn.position), opponent)] ?? first;
    }
    if (!initial || this.matchRole === 'host') return null;
    const second = map.playerSpawns[1];
    if (second) return second;
    const first = map.playerSpawns[0];
    if (!first) return null;
    // One shared spawn: stand beside the host, on whichever side has room.
    const sideX = Math.cos(first.yaw);
    const sideZ = -Math.sin(first.yaw);
    for (const step of [SIDE_STEP, -SIDE_STEP]) {
      const position = first.position.clone();
      position.x += sideX * step;
      position.z += sideZ * step;
      position.y += 0.05;
      if (this.ctx.world.capsuleFits(position, BODY_RADIUS, BODY_HEIGHT)) return { position, yaw: first.yaw };
    }
    return first;
  }

  reportMatch(wave: number, enemies: number, result: '' | 'won' | 'lost', localKills: number): void {
    if (!this.inMatch || this.matchRole !== 'host' || this.match?.mode !== 'coop' || !this.localLoaded) return;
    // The last kill must reach the guest before the result it produced.
    if (result !== '') this.sync?.flush();
    const now = performance.now();
    const key = `${wave}|${enemies}|${result}|${localKills}|${this.partnerKills}`;
    // Say it when something changed, and twice a second regardless.
    if (key === this.lastReport && now - this.lastReportAt < MATCH_REPORT_MS) return;
    this.lastReport = key;
    this.lastReportAt = now;
    this.send({ t: 'match', wave, enemies, result, hostKills: localKills, guestKills: this.partnerKills });
  }

  private maybeGo(): void {
    if (this.matchRole !== 'host' || !this.match || !this.localLoaded || !this.peerLoaded || this.goAt !== Number.POSITIVE_INFINITY) return;
    // The host's clock is the reference; the guest converts it with its clock estimate.
    this.goAt = performance.now() + COUNTDOWN_MS;
    this.send({ t: 'go', at: this.goAt });
  }

  /** The other player disconnected, closed the tab or stopped sending. */
  private peerLost(reason: 'left' | 'timeout'): void {
    if (reason === 'timeout') this.send({ t: 'bye', reason: 'timeout' satisfies ByeReason });
    const error: NetErrorCode = reason === 'timeout' ? 'peer-timeout' : 'peer-left';
    this.closeConnection();
    this.patch({ step: 'idle', role: null, method: null, code: '', error, peerReady: false, localReady: false, inMatch: false });
    this.orphanMatch(error);
  }

  private orphanMatch(notice: NetNotice): void {
    if (!this.match || this.peerGone) return;
    this.peerGone = true;
    this.lossNotice = notice;
    if (this.localLoaded) this.applyLoss();
  }

  /** Carry out what losing the other player means for the loaded match. */
  private applyLoss(): void {
    const match = this.match;
    if (!match) return;
    const sync = this.sync;
    try {
      if (match.mode === 'duel') {
        sync?.dropRemote();
        this.hooks.endMatch(this.hooks.kills >= this.hooks.deaths ? 'won' : 'lost');
      } else if (this.matchRole === 'host') {
        sync?.dropRemote();
      } else {
        const wave = sync?.hostMatch?.wave ?? 0;
        const enemies = sync ? sync.dropProxies() : match.botCount;
        sync?.dropRemote();
        this.lossNotice = 'took-over';
        this.hooks.takeOver(enemies, wave);
      }
    } catch (error) {
      console.error('Could not carry on after the other player left', error);
    }
  }

  update(dt: number, running: boolean): void {
    const now = performance.now();
    const link = this.link;
    if (link?.open && now >= this.nextPingAt) {
      this.nextPingAt = now + (this.pingsSent++ < PING_FAST_COUNT ? PING_FAST_MS : PING_SLOW_MS);
      link.sendState(encodePing(this.pingId++ & 0xff, now));
      const rtt = Math.round(this.clock.rtt);
      if (rtt !== this.rttShown) {
        this.rttShown = rtt;
        this.patch({ rttMs: rtt });
      }
    }
    const sync = this.sync;
    if (!sync) return;
    sync.update(dt, now, running);
    if (!running || !this.inMatch || this.frozen) {
      // Nothing is expected from the other player yet: the timeout starts with the match.
      sync.lastStateAt = now;
      return;
    }
    if (now - sync.lastStateAt > PEER_TIMEOUT_MS) this.peerLost('timeout');
  }

  dispose(): void {
    this.abort.abort();
    this.send({ t: 'bye', reason: 'left' });
    this.closeConnection();
    this.sync?.dispose();
    this.sync = null;
    this.listeners.clear();
  }
}
