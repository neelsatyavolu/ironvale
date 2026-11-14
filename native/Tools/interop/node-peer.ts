// Node reference peer for the native-port interop tests (PLAN.md 5.4 layer 3). It runs the web's
// own NetSession (src/net/session.ts), with its RoomSignaling/ManualSignaling, PeerLink, ICE
// fetch and codecs, over the node-datachannel RTCPeerConnection polyfill, so the native client is
// tested against the reference implementation rather than a re-implementation of it.
//
// No Game runs here. Where the game would load a map and create MatchSync, the peer installs a
// stand-in that applies MatchSync's receive rules (WeaponGate per shooter, capDamage, throw speed,
// blasts only after a throw) and sends through the session's own MatchLink. The stand-in reaches
// into three private fields of NetSession (`sync`, `queued`, `goAt`) and its `matchLink`; that is
// the price of driving the real session without a running game.
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { RTCPeerConnection as PolyPeerConnection, RTCSessionDescription, RTCIceCandidate } from 'node-datachannel/polyfill';
import type { GameContext } from '../../../src/game/contracts';
import type { LobbyState, NetGameHooks, NetMatchConfig, NetRole, NetMethod } from '../../../src/net/api';
import { capDamage, WeaponGate } from '../../../src/net/limits';
import {
  decodeBinary,
  encodePlayerState,
  encodeShot,
  parseEvent,
  PROTOCOL_VERSION,
  type BinaryMessage,
  type NetEvent,
  type ShotMessage,
} from '../../../src/net/protocol';
import { NetSession } from '../../../src/net/session';
import { WEAPON_DEFS } from '../../../src/weapons/defs';
import { GRENADE } from '../../../src/weapons/grenade-math';
import { GRENADE_DEF } from '../../../src/weapons/grenades';
import type { WeaponId } from '../../../src/weapons/models/api';

const HERE = new URL('.', import.meta.url).pathname;
/** `GRENADE_SPEED_SLACK` in match.ts is not exported; contract-export extracts it into protocol.json. */
const GRENADE_SPEED_SLACK = (
  JSON.parse(readFileSync(`${HERE}../../Contract/protocol.json`, 'utf8')) as { timing: { match: { GRENADE_SPEED_SLACK: number } } }
).timing.match.GRENADE_SPEED_SLACK;

export interface NodePeerOptions {
  readonly role: NetRole;
  readonly method: NetMethod;
  /** Relay base URL (`ws://127.0.0.1:PORT`). */
  readonly signal: string;
  /** Origin header for the relay: the web page's origin. */
  readonly origin: string;
  /** Where to write the code to pass on, and where to wait for the one this peer is given. */
  readonly codeOut: string;
  readonly codeIn: string;
  readonly log: string;
  readonly scenario?: string;
  readonly expectError?: string;
  readonly timeoutMs?: number;
  readonly name?: string;
}

export interface NodePeerResult {
  readonly ok: boolean;
  readonly reason: string;
  readonly rejections: number;
}

interface Scenario {
  readonly config: NetMatchConfig;
  readonly durationMs: number;
  readonly timeline: readonly {
    readonly at: number;
    readonly repeat?: { readonly every: number; readonly count: number };
    readonly event?: unknown;
    readonly shot?: unknown;
  }[];
}

type ScriptedSend = { readonly kind: 'event'; readonly event: NetEvent } | { readonly kind: 'shot'; readonly shot: ShotMessage };

function substitute(value: unknown, me: number, peer: number): unknown {
  if (value === '$me') return me;
  if (value === '$peer') return peer;
  if (Array.isArray(value)) return value.map((item) => substitute(item, me, peer));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, me, peer)]));
  }
  return value;
}

function scriptedSends(scenario: Scenario, me: number, peer: number): { at: number; send: ScriptedSend }[] {
  const sends: { at: number; send: ScriptedSend; order: number }[] = [];
  for (const entry of scenario.timeline) {
    let send: ScriptedSend;
    if (entry.event !== undefined) {
      const event = parseEvent(JSON.stringify(substitute(entry.event, me, peer)));
      if (!event) throw new Error(`invalid scripted event ${JSON.stringify(entry.event)}`);
      send = { kind: 'event', event };
    } else {
      send = { kind: 'shot', shot: substitute(entry.shot, me, peer) as ShotMessage };
    }
    const count = entry.repeat?.count ?? 1;
    for (let i = 0; i < count; i++) sends.push({ at: entry.at + (entry.repeat?.every ?? 0) * i, send, order: sends.length });
  }
  return sends.sort((a, b) => a.at - b.at || a.order - b.order);
}

function hex(data: ArrayBuffer): string {
  return Buffer.from(data).toString('hex');
}

let globalsInstalled = false;

/** Browser globals for the web modules: WebRTC from node-datachannel, and WebSocket/fetch with an Origin header. */
function installGlobals(origin: string, onChannel: (channel: RTCDataChannel) => void): void {
  const g = globalThis as Record<string, unknown>;
  // Each peer in this process sets the hook it wants; the classes are installed once.
  g.__ivOnChannel = onChannel;
  g.__ivOrigin = origin;
  if (globalsInstalled) return;
  globalsInstalled = true;
  class TappedPeerConnection extends (PolyPeerConnection as unknown as typeof RTCPeerConnection) {
    override createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel {
      const channel = super.createDataChannel(label, init);
      (g.__ivOnChannel as (channel: RTCDataChannel) => void)(channel);
      return channel;
    }
  }
  g.RTCPeerConnection = TappedPeerConnection;
  g.RTCSessionDescription = RTCSessionDescription;
  g.RTCIceCandidate = RTCIceCandidate;
  const NodeWebSocket = globalThis.WebSocket;
  g.WebSocket = class extends NodeWebSocket {
    constructor(url: string | URL) {
      // Node's WebSocket (undici) takes headers; a browser sends its page origin by itself.
      super(url, { headers: { Origin: g.__ivOrigin as string } } as unknown as string[]);
    }
  };
  const nodeFetch = globalThis.fetch;
  g.fetch = (input: RequestInfo | URL, init: RequestInit = {}) =>
    nodeFetch(input, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Origin: g.__ivOrigin as string } });
}

export async function runNodePeer(options: NodePeerOptions): Promise<NodePeerResult> {
  const scenario = JSON.parse(readFileSync(options.scenario ?? `${HERE}scenario.json`, 'utf8')) as Scenario;
  const me = options.role === 'host' ? 0 : 1;
  const peer = 1 - me;
  const sends = scriptedSends(scenario, me, peer);
  writeFileSync(options.log, '');
  const log = (kind: string, fields: Record<string, unknown> = {}): void =>
    appendFileSync(options.log, `${JSON.stringify({ at: Math.round(performance.now()), kind, ...fields })}\n`);

  let rejections = 0;
  const reject = (reason: string, fields: Record<string, unknown> = {}): void => {
    rejections++;
    log('reject', { reason, ...fields });
  };

  installGlobals(options.origin, (channel) => {
    const ch = channel.label;
    const send = channel.send.bind(channel);
    channel.send = ((data: string | ArrayBuffer) => {
      send(data as string);
      if (typeof data === 'string') log('sent', { ch, frame: 'text', data });
      else log('sent', { ch, frame: 'binary', data: hex(data) });
    }) as typeof channel.send;
    channel.addEventListener('message', (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data === 'string') {
        log('recv', { ch, frame: 'text', data });
        if (ch !== 'events') reject('text frame on state', { ch, frame: 'text', data });
        else if (!parseEvent(data)) reject('invalid event', { ch, frame: 'text', data });
      } else if (data instanceof ArrayBuffer) {
        log('recv', { ch, frame: 'binary', data: hex(data) });
        if (!decodeBinary(data)) reject('undecodable binary', { ch, frame: 'binary', data: hex(data) });
      } else {
        reject('frame of unknown type', { ch });
      }
    });
  });

  const hooks = {
    listMaps: () => [{ id: 'railyard' }, { id: 'harbor' }, { id: 'headworks' }],
    startMatch: () => Promise.resolve(),
    endMatch: () => undefined,
    waveStarted: () => undefined,
    takeOver: () => undefined,
    kills: 0,
    deaths: 0,
  } as unknown as NetGameHooks;
  const ctx = { settings: { value: { gameplay: { difficulty: 'regular' } } } } as unknown as GameContext;
  const session = new NetSession(ctx, hooks);
  const inside = session as unknown as {
    sync: unknown;
    queued: NetEvent[];
    goAt: number;
    matchLink: { sendState(data: ArrayBuffer): void; sendEvent(event: NetEvent): void; sendShot(data: ArrayBuffer): void };
    closeConnection(): void;
  };
  session.setName(options.name ?? 'Web');
  log('start', { role: options.role, method: options.method, origin: options.origin, protocol: PROTOCOL_VERSION });

  // MatchSync's receive rules, without a game.
  const gates = new Map<number, WeaponGate>();
  const gate = (wire: number): WeaponGate => {
    const existing = gates.get(wire) ?? new WeaponGate();
    gates.set(wire, existing);
    return existing;
  };
  let peerGrenades = 0;
  let statesReceived = 0;
  const stand = {
    remote: { name: '', alive: true, id: -1 },
    partnerDeaths: 0,
    partnerKills: 0,
    hostMatch: null,
    lastStateAt: performance.now(),
    handleBinary(message: BinaryMessage, now: number): void {
      if (message.type === 'state') {
        statesReceived++;
        stand.lastStateAt = now;
      } else if (message.type === 'shot') {
        const shot = message.shot;
        if (shot.actor !== peer) reject(`shot from ${shot.actor}`);
        else if (!gate(shot.actor).allowShot(WEAPON_DEFS[shot.weapon], now)) reject('shot over the rate gate');
      } else if (message.type === 'bots') reject('bot snapshot in a duel without bots');
    },
    handleEvent(event: NetEvent, now: number): void {
      switch (event.t) {
        case 'hit': {
          if (event.target !== me || event.attacker !== peer) return reject(`hit ${event.attacker}->${event.target}`);
          const def = event.weapon === 'grenade' ? GRENADE_DEF : WEAPON_DEFS[event.weapon];
          const allowed = event.weapon === 'grenade' ? peerGrenades > 0 : gate(event.attacker).allowHit(def, now);
          if (!allowed) return reject('hit over the rate gate');
          if (capDamage(def, event.amount) !== event.amount) return reject('hit over the damage cap');
          return;
        }
        case 'death':
          if (event.victim !== me || event.killer !== peer) reject(`death ${event.killer}->${event.victim}`);
          return;
        case 'action':
          if (event.actor !== peer) reject(`action from ${event.actor}`);
          return;
        case 'nade':
          if (Math.hypot(...event.v) > GRENADE.throwSpeed * GRENADE_SPEED_SLACK) return reject('grenade thrown too fast');
          peerGrenades++;
          return;
        case 'switch':
        case 'boom':
          return;
        default:
          reject(`unexpected match event ${event.t}`);
      }
    },
    update(): void {},
    flush(): void {},
    dispose(): void {},
    dropRemote(): void {},
    dropProxies(): number {
      return 0;
    },
  };

  let finSent = false;
  let finReceived = false;
  session.onChat((line) => {
    log('chat', { name: line.name, text: line.text, mine: line.mine });
    if (!line.mine && line.text === 'fin') finReceived = true;
  });

  return new Promise<NodePeerResult>((resolve) => {
    let done = false;
    let streamStart = -1;
    let nextSend = 0;
    let seq = 0;
    let statesSent = 0;
    let weapon: WeaponId = 'm4a1';
    let byeSent = false;
    let codeWritten = '';
    let waitingForReply = false;
    let readySent = false;
    let lastStep = '';

    const finish = (ok: boolean, reason: string): void => {
      if (done) return;
      done = true;
      clearInterval(ticker);
      clearTimeout(deadline);
      unsubscribe();
      inside.closeConnection();
      const success = ok && rejections === 0;
      log('done', { ok: success, reason, rejections, statesSent, statesReceived, rttMs: session.state.rttMs });
      resolve({ ok: success, reason, rejections });
    };

    const readCode = (then: (code: string) => void): void => {
      if (done) return;
      if (existsSync(options.codeIn)) {
        const code = readFileSync(options.codeIn, 'utf8');
        if (code) {
          log('code-in', { chars: code.length });
          then(code);
          return;
        }
      }
      setTimeout(() => readCode(then), 50);
    };

    const onState = (state: LobbyState): void => {
      if (state.step !== lastStep) {
        lastStep = state.step;
        log('phase', { phase: state.step });
      }
      if (state.code && state.code !== codeWritten) {
        codeWritten = state.code;
        log('code', { chars: state.code.length });
        writeFileSync(`${options.codeOut}.tmp`, state.code);
        writeFileSync(options.codeOut, state.code);
        if (options.role === 'host' && options.method === 'manual' && !waitingForReply) {
          waitingForReply = true;
          readCode((reply) => session.acceptReply(reply));
        }
      }
      if (state.error) {
        log('error', { error: state.error });
        if (options.expectError) finish(state.error === options.expectError, `error ${state.error}, expected ${options.expectError}`);
        else if (state.error === 'peer-left' && finSent && finReceived) finish(true, 'peer said bye after the script');
        else finish(false, `session failed: ${state.error}`);
        return;
      }
      if (state.step !== 'connected') return;
      if (options.role === 'guest' && !readySent && sameConfig(state.config, scenario.config)) {
        readySent = true;
        session.setReady(true);
      }
      if (options.role === 'host' && state.peerReady && !state.inMatch) session.start();
      if (state.inMatch && inside.sync === null) {
        // The game would build the map, create MatchSync in enterMap and then call matchLoaded.
        setTimeout(() => {
          if (done || inside.sync !== null) return;
          inside.sync = stand;
          const queued = inside.queued;
          inside.queued = [];
          for (const event of queued) stand.handleEvent(event, performance.now());
          log('begin-match', { map: state.config.mapId, mode: state.config.mode });
          session.matchLoaded();
        }, 0);
      }
    };
    const unsubscribe = session.subscribe(onState);

    let last = performance.now();
    const ticker = setInterval(() => {
      if (done) return;
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      if (streamStart < 0 && Number.isFinite(inside.goAt) && inside.sync !== null) {
        streamStart = now;
        log('go', { goAt: Math.round(inside.goAt) });
        log('stream-start');
      }
      if (streamStart >= 0) tickScript(now);
      session.update(dt, streamStart >= 0);
      if (options.role === 'guest' && finSent && finReceived && !byeSent) {
        byeSent = true;
        inside.matchLink.sendEvent({ t: 'bye', reason: 'ended' });
        setTimeout(() => finish(true, 'script complete'), 1000);
      }
    }, 4);
    const deadline = setTimeout(() => finish(false, 'timed out'), options.timeoutMs ?? 90_000);

    const tickScript = (now: number): void => {
      const elapsed = now - streamStart;
      while (nextSend < sends.length && sends[nextSend]!.at <= elapsed) {
        const { send } = sends[nextSend]!;
        if (send.kind === 'event') {
          if (send.event.t === 'switch') weapon = send.event.weapon;
          inside.matchLink.sendEvent(send.event);
        } else {
          inside.matchLink.sendShot(encodeShot(send.shot));
        }
        nextSend++;
      }
      if (elapsed < scenario.durationMs) {
        // Exactly 30 per second of script: a late tick catches up rather than skipping a frame.
        while (statesSent < Math.floor((elapsed * 30) / 1000) + 1) {
          const angle = elapsed / 1000;
          inside.matchLink.sendState(
            encodePlayerState({
              seq: seq++ & 0xffff,
              time: now,
              x: 3 * Math.cos(angle) + me,
              y: 0.02,
              z: 3 * Math.sin(angle),
              vx: -3 * Math.sin(angle),
              vy: 0,
              vz: 3 * Math.cos(angle),
              yaw: angle + Math.PI / 2,
              pitch: -0.05,
              crouching: false,
              sprinting: elapsed > 5000,
              aiming: elapsed < 2000,
              alive: true,
              onGround: true,
              reloading: false,
              weapon,
              health: 100,
              life: 0,
            }),
          );
          statesSent++;
        }
      } else if (!finSent && nextSend === sends.length) {
        finSent = true;
        session.sendChat('fin');
        log('stream-end', { statesSent });
      }
    };

    if (options.role === 'host') {
      session.setConfig(scenario.config);
      session.host(options.method);
    } else {
      readCode((code) => session.join(options.method, code));
    }
  });
}

function sameConfig(a: NetMatchConfig, b: NetMatchConfig): boolean {
  const keys = Object.keys(b) as (keyof NetMatchConfig)[];
  return keys.length === Object.keys(a).length && keys.every((key) => a[key] === b[key]);
}
