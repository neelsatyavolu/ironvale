// Node reference peer for the M7b co-op and duel-bot cross-play scenarios (PLAN.md 5.4, run by
// coop.test.ts against `ivpeer --game`). Like node-peer.ts it runs the web's own NetSession (lobby,
// signaling, transport, codecs, reportMatch, applyLoss and the takeover hook) over node-datachannel,
// and installs a stand-in for MatchSync that applies the web's receive rules for bots
// (src/net/match.ts: botSpawn and bot snapshots only from a host with bots, WeaponGate per bot and per
// player, capDamage, partners cannot hurt partners, deaths counted by side).
//
// No Game runs here. As the guest it stands at a spawn, streams its state at 30 Hz, shoots the
// host's enemy bots it was told about, and takes the bots' hits (dying and coming back like a player).
// As the host it plays stand-in bots: announces them, sends 12 Hz bot snapshots and `match` reports
// through the session's own reportMatch, kills some on a timer, lets a duel bot fight, and can leave.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { RTCPeerConnection as PolyPeerConnection, RTCIceCandidate, RTCSessionDescription } from 'node-datachannel/polyfill';
import type { GameContext } from '../../../src/game/contracts';
import type { LobbyState, NetGameHooks, NetMatchConfig, NetRole } from '../../../src/net/api';
import { capDamage, WeaponGate } from '../../../src/net/limits';
import {
  decodeBinary,
  encodeBotSnapshot,
  encodePlayerState,
  encodeShot,
  parseEvent,
  WIRE_BOT_BASE,
  type BinaryMessage,
  type BotState,
  type NetEvent,
  type Vec3,
} from '../../../src/net/protocol';
import { NetSession } from '../../../src/net/session';
import { WEAPON_DEFS } from '../../../src/weapons/defs';

export interface CoopPeerOptions {
  readonly role: NetRole;
  readonly signal: string;
  readonly origin: string;
  readonly codeOut: string;
  readonly codeIn: string;
  readonly log: string;
  /** Host: the match to propose. Guest: the match to accept. */
  readonly config: NetMatchConfig;
  /** Where this peer's player stands (feet). */
  readonly stand: Vec3;
  /** Run this long after go, then finish (unless the other side left first). */
  readonly durationMs: number;
  readonly timeoutMs?: number;
  /** Host: stand-in bots at these spots (co-op enemies, or the one duel bot). */
  readonly fakeBots?: readonly Vec3[];
  /** Host: one stand-in bot dies (killed by this player) at each of these times after go. */
  readonly killFakeAtMs?: readonly number[];
  /** Host, duel bot: ms between the bot's lethal attacks on whoever it fights (the guest, or this player). */
  readonly duelBotAttackEveryMs?: number;
  /** Guest: shoot this many of the host's enemy bots dead, starting at this time. */
  readonly killBots?: { readonly count: number; readonly startMs: number };
  /** Leave the match (bye) this long after go. */
  readonly leaveAtMs?: number;
}

export interface CoopPeerResult {
  readonly ok: boolean;
  readonly reason: string;
  readonly rejections: string[];
  /** Bots the host announced (`botSpawn`), by wire id. */
  readonly botSpawns: number;
  /** Distinct bot ids seen in snapshots, and how many of them were never announced. */
  readonly snapshotBots: number;
  readonly unknownSnapshotBots: number;
  readonly botSnapshots: number;
  readonly botShots: number;
  readonly hitsTaken: number;
  /** Deaths of bots, by killer wire id. */
  readonly botDeathsBy: Record<string, number>;
  /** This player's deaths and kills of the other player (duel). */
  readonly deaths: number;
  readonly peerDeaths: number;
  readonly lastMatch: { wave: number; enemies: number; result: string; hostKills: number; guestKills: number } | null;
  readonly takeOver: { enemies: number; wave: number } | null;
  readonly statesReceived: number;
  readonly peerLeft: boolean;
}

const BYE_GRACE_MS = 1500;
const STATE_HZ = 30;
const BOT_HZ = 12;
const REPORT_MS = 250;
const RESPAWN_MS = 3000;

function hex(data: ArrayBuffer): string {
  return Buffer.from(data).toString('hex');
}

let globalsInstalled = false;

/** Browser globals for the web modules (as in node-peer.ts): WebRTC from node-datachannel, WebSocket/fetch with an Origin. */
function installGlobals(origin: string, onChannel: (channel: RTCDataChannel) => void): void {
  const g = globalThis as Record<string, unknown>;
  g.__ivCoopOnChannel = onChannel;
  g.__ivCoopOrigin = origin;
  if (globalsInstalled) return;
  globalsInstalled = true;
  class TappedPeerConnection extends (PolyPeerConnection as unknown as typeof RTCPeerConnection) {
    override createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel {
      const channel = super.createDataChannel(label, init);
      (g.__ivCoopOnChannel as (channel: RTCDataChannel) => void)(channel);
      return channel;
    }
  }
  g.RTCPeerConnection = TappedPeerConnection;
  g.RTCSessionDescription = RTCSessionDescription;
  g.RTCIceCandidate = RTCIceCandidate;
  const NodeWebSocket = globalThis.WebSocket;
  g.WebSocket = class extends NodeWebSocket {
    constructor(url: string | URL) {
      super(url, { headers: { Origin: g.__ivCoopOrigin as string } } as unknown as string[]);
    }
  };
  const nodeFetch = globalThis.fetch;
  g.fetch = (input: RequestInfo | URL, init: RequestInit = {}) =>
    nodeFetch(input, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Origin: g.__ivCoopOrigin as string } });
}

interface FakeBot {
  readonly wire: number;
  readonly at: Vec3;
  alive: boolean;
  damage: number;
}

export async function runCoopPeer(options: CoopPeerOptions): Promise<CoopPeerResult> {
  const me = options.role === 'host' ? 0 : 1;
  const peer = 1 - me;
  const config = options.config;
  const coop = config.mode === 'coop';
  const hostBots = coop || config.duelBot !== 'none';
  writeFileSync(options.log, '');
  const log = (kind: string, fields: Record<string, unknown> = {}): void =>
    appendFileSync(options.log, `${JSON.stringify({ at: Math.round(performance.now()), kind, ...fields })}\n`);
  const rejections: string[] = [];
  const reject = (reason: string, fields: Record<string, unknown> = {}): void => {
    rejections.push(reason);
    log('reject', { reason, ...fields });
  };

  installGlobals(options.origin, (channel) => {
    const ch = channel.label;
    channel.addEventListener('message', (event: MessageEvent) => {
      const data: unknown = event.data;
      if (typeof data === 'string') {
        if (ch !== 'events') reject('text frame on state', { ch, data });
        else if (!parseEvent(data)) reject('invalid event', { ch, data });
        else if (!data.includes('"t":"ping"')) log('recv', { ch, data });
      } else if (data instanceof ArrayBuffer) {
        if (!decodeBinary(data)) reject('undecodable binary', { ch, data: hex(data) });
      }
    });
  });

  // Tallies.
  const announced = new Map<number, { team: 'enemy' | 'friend' }>();
  const seenInSnapshots = new Set<number>();
  const snapshotAlive = new Map<number, boolean>();
  let botSnapshots = 0;
  let botShots = 0;
  let hitsTaken = 0;
  let deaths = 0;
  let peerDeaths = 0;
  let statesReceived = 0;
  let health = 100;
  let life = 0;
  let deadUntil = -1;
  let peerLeft = false;
  const botDeathsBy: Record<string, number> = {};
  let lastMatch: CoopPeerResult['lastMatch'] = null;
  let takeOver: CoopPeerResult['takeOver'] = null;
  const fake: FakeBot[] = (options.fakeBots ?? []).map((at, i) => ({ wire: WIRE_BOT_BASE + 100 + i, at, alive: true, damage: 0 }));

  const gates = new Map<number, WeaponGate>();
  const gate = (wire: number): WeaponGate => {
    const existing = gates.get(wire) ?? new WeaponGate();
    gates.set(wire, existing);
    return existing;
  };

  // A duel bot fights for its owner; co-op bots fight both players.
  const botIsEnemyOfMe = (): boolean => coop || (config.duelBot === 'host' ? me === 1 : me === 0);

  const stand = {
    remote: { name: '', alive: true, id: -1 },
    partnerDeaths: 0,
    partnerKills: 0,
    hostMatch: null as { wave: number; enemies: number } | null,
    lastStateAt: performance.now(),
    handleBinary(message: BinaryMessage, now: number): void {
      if (message.type === 'state') {
        statesReceived++;
        stand.lastStateAt = now;
      } else if (message.type === 'bots') {
        if (options.role !== 'guest' || !hostBots) return reject('bot snapshot with no host bots');
        botSnapshots++;
        for (const bot of message.bots) {
          seenInSnapshots.add(bot.id);
          snapshotAlive.set(bot.id, bot.alive);
        }
      } else if (message.type === 'shot') {
        const shot = message.shot;
        const fromBot = options.role === 'guest' && hostBots && announced.has(shot.actor);
        if (shot.actor !== peer && !fromBot) return reject(`shot from ${shot.actor}`);
        if (!gate(shot.actor).allowShot(WEAPON_DEFS[shot.weapon], now)) return reject('shot over the rate gate', { actor: shot.actor });
        if (fromBot) botShots++;
      }
    },
    handleEvent(event: NetEvent, now: number): void {
      switch (event.t) {
        case 'botSpawn':
          if (options.role !== 'guest' || !hostBots) return reject('botSpawn with no host bots');
          announced.set(event.id, { team: botIsEnemyOfMe() ? 'enemy' : 'friend' });
          log('botSpawn', { id: event.id, weapon: event.weapon });
          return;
        case 'hit': {
          const def = WEAPON_DEFS[event.weapon as keyof typeof WEAPON_DEFS];
          if (!def) return reject(`hit with ${event.weapon}`);
          if (event.target === me) {
            const fromBot = announced.get(event.attacker);
            if (event.attacker === peer && coop) return reject('a partner hurt a partner');
            if (event.attacker !== peer && fromBot?.team !== 'enemy') return reject(`hit on me from ${event.attacker}`);
            if (!gate(event.attacker).allowHit(def, now)) return reject('hit over the rate gate', { attacker: event.attacker });
            if (capDamage(def, event.amount) !== event.amount) return reject('hit over the damage cap', { amount: event.amount });
            hitsTaken++;
            if (deadUntil >= 0) return;
            health -= event.amount;
            if (health <= 0) {
              deaths++;
              deadUntil = now + RESPAWN_MS;
              link().sendEvent({ t: 'death', victim: me, killer: event.attacker, weapon: event.weapon, headshot: false, life, d: [0, 0, -1] });
              log('died', { killer: event.attacker, life });
            }
            return;
          }
          // The host's stand-in bots, hit by the guest.
          const bot = options.role === 'host' ? fake.find((b) => b.wire === event.target) : undefined;
          if (!bot) return reject(`hit on ${event.target}`);
          if (event.attacker !== peer) return reject(`hit on a bot from ${event.attacker}`);
          if (!coop && config.duelBot === 'guest') return reject('the guest hit its own duel bot');
          if (!gate(event.attacker).allowHit(def, now)) return reject('hit over the rate gate');
          if (!bot.alive) return;
          bot.damage += capDamage(def, event.amount);
          if (bot.damage >= 100) killFake(bot, peer, event.weapon);
          return;
        }
        case 'death':
          if (event.victim === peer) {
            peerDeaths++;
            stand.partnerDeaths++;
            return;
          }
          if (event.victim >= WIRE_BOT_BASE) {
            if (options.role === 'guest' && !announced.has(event.victim)) return reject(`death of unannounced bot ${event.victim}`);
            botDeathsBy[String(event.killer)] = (botDeathsBy[String(event.killer)] ?? 0) + 1;
            log('botDied', { victim: event.victim, killer: event.killer });
            return;
          }
          return reject(`death ${event.killer}->${event.victim}`);
        case 'match':
          if (options.role !== 'guest' || !coop) return reject('match report to a host');
          stand.hostMatch = { wave: event.wave, enemies: event.enemies };
          stand.partnerKills = event.hostKills;
          lastMatch = { wave: event.wave, enemies: event.enemies, result: event.result, hostKills: event.hostKills, guestKills: event.guestKills };
          return;
        case 'action':
          if (event.actor !== peer && !announced.has(event.actor)) reject(`action from ${event.actor}`);
          return;
        case 'switch':
        case 'nade':
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
    /** The guest's stand-ins: the enemies still standing in the last snapshot. */
    dropProxies(): number {
      let alive = 0;
      for (const [id, on] of snapshotAlive) if (on && announced.get(id)?.team === 'enemy') alive++;
      return alive;
    },
  };

  const hooks = {
    listMaps: () => [{ id: 'railyard' }, { id: 'harbor' }, { id: 'headworks' }, { id: 'range' }],
    startMatch: () => Promise.resolve(),
    endMatch: (result: string) => log('endMatch', { result }),
    waveStarted: () => log('waveStarted'),
    takeOver: (enemies: number, wave: number) => {
      takeOver = { enemies, wave };
      log('takeOver', { enemies, wave });
    },
    get kills() {
      return peerDeaths;
    },
    get deaths() {
      return deaths;
    },
  } as unknown as NetGameHooks;
  const ctx = { settings: { value: { gameplay: { difficulty: config.difficulty } } } } as unknown as GameContext;
  const session = new NetSession(ctx, hooks);
  const inside = session as unknown as {
    sync: unknown;
    queued: NetEvent[];
    goAt: number;
    matchLink: { sendState(data: ArrayBuffer): void; sendEvent(event: NetEvent): void; sendShot(data: ArrayBuffer): void };
    closeConnection(): void;
  };
  const link = () => inside.matchLink;
  session.setName(options.role === 'host' ? 'Web host' : 'Web guest');
  log('start', { role: options.role, config });

  function killFake(bot: FakeBot, killer: number, weapon: string): void {
    bot.alive = false;
    if (killer === peer) stand.partnerKills++;
    link().sendEvent({ t: 'death', victim: bot.wire, killer, weapon: weapon as 'm4a1', headshot: false, life: 0, d: [0, 0, -1] });
    log('fakeDied', { wire: bot.wire, killer });
  }

  return new Promise<CoopPeerResult>((resolve) => {
    let done = false;
    let goAt = -1;
    let statesSent = 0;
    let snapshotsSent = 0;
    let seq = 0;
    let botSeq = 0;
    let lastReport = 0;
    let lastAttack = 0;
    let killsDone = 0;
    let lastShotAt = 0;
    let readySent = false;
    let startSent = false;
    let leftAt = -1;
    let codeWritten = '';
    let lastStep = '';
    const killedByMe = (): number => botDeathsBy[String(me)] ?? 0;

    const finish = (ok: boolean, reason: string): void => {
      if (done) return;
      done = true;
      clearInterval(ticker);
      clearTimeout(deadline);
      unsubscribe();
      if (leftAt < 0) link().sendEvent({ t: 'bye', reason: 'ended' });
      setTimeout(() => inside.closeConnection(), 300);
      const result: CoopPeerResult = {
        ok: ok && rejections.length === 0,
        reason,
        rejections,
        botSpawns: announced.size,
        snapshotBots: seenInSnapshots.size,
        unknownSnapshotBots: [...seenInSnapshots].filter((id) => !announced.has(id)).length,
        botSnapshots,
        botShots,
        hitsTaken,
        botDeathsBy,
        deaths,
        peerDeaths,
        lastMatch,
        takeOver,
        statesReceived,
        peerLeft,
      };
      log('done', { ...result, statesSent, snapshotsSent });
      resolve(result);
    };

    const readCode = (then: (code: string) => void): void => {
      if (done) return;
      if (existsSync(options.codeIn)) {
        const code = readFileSync(options.codeIn, 'utf8');
        if (code) return then(code);
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
        writeFileSync(options.codeOut, state.code);
      }
      if (state.error) {
        log('error', { error: state.error });
        if (state.error === 'peer-left' || state.error === 'peer-timeout') {
          peerLeft = true;
          // The session has already run applyLoss (and the takeover hook); let it settle, then report.
          setTimeout(() => finish(true, `peer gone: ${state.error}`), BYE_GRACE_MS);
        } else if (leftAt < 0) {
          finish(false, `session failed: ${state.error}`);
        }
        return;
      }
      if (state.step !== 'connected') return;
      if (options.role === 'guest' && !readySent && state.config.mapId === config.mapId && state.config.mode === config.mode) {
        readySent = true;
        session.setReady(true);
      }
      if (options.role === 'host' && state.peerReady && !startSent) {
        startSent = true;
        session.start();
      }
      if (state.inMatch && inside.sync === null) {
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

    const sendState = (now: number): void => {
      const alive = deadUntil < 0;
      link().sendState(
        encodePlayerState({
          seq: seq++ & 0xffff,
          time: now,
          x: options.stand[0],
          y: options.stand[1],
          z: options.stand[2],
          vx: 0,
          vy: 0,
          vz: 0,
          yaw: 0,
          pitch: 0,
          crouching: false,
          sprinting: false,
          aiming: true,
          alive,
          onGround: true,
          reloading: false,
          weapon: 'm4a1',
          health: Math.max(0, Math.round(health)),
          life,
        }),
      );
      statesSent++;
    };

    const sendBots = (now: number): void => {
      const bots: BotState[] = fake.map((b) => ({
        id: b.wire,
        x: b.at[0],
        y: b.at[1],
        z: b.at[2],
        yaw: 0,
        pitch: 0,
        speed: 0,
        crouching: false,
        aiming: true,
        reloading: false,
        alive: b.alive,
        weapon: 'm4a1',
      }));
      link().sendState(encodeBotSnapshot(botSeq++ & 0xffff, now, bots));
      snapshotsSent++;
    };

    /** Guest: one round at the first standing enemy bot, then the hit (as the web's own MatchSync sends them). */
    const shootBot = (now: number): void => {
      if (killedByMe() >= (options.killBots?.count ?? 0) || now - lastShotAt < 120) return;
      const target = [...announced.entries()].find(([id, b]) => b.team === 'enemy' && snapshotAlive.get(id) === true)?.[0];
      if (target === undefined) return;
      lastShotAt = now;
      const def = WEAPON_DEFS.m4a1;
      const from: Vec3 = [options.stand[0], options.stand[1] + 1.5, options.stand[2]];
      link().sendShot(encodeShot({ actor: me, weapon: 'm4a1', muzzle: from, direction: [0, 0, -1], ends: [[from[0], from[1], from[2] - 10]] }));
      link().sendEvent({
        t: 'hit',
        target,
        attacker: me,
        weapon: 'm4a1',
        zone: 'head',
        amount: def.damage * def.headshotMultiplier,
        p: [from[0], from[1], from[2] - 10],
        d: [0, 0, -1],
      });
    };

    /** Host: the duel bot lands a lethal attack on whoever it fights. */
    const duelBotAttack = (now: number): void => {
      const bot = fake[0];
      if (!bot || !options.duelBotAttackEveryMs || now - lastAttack < options.duelBotAttackEveryMs) return;
      lastAttack = now;
      const def = WEAPON_DEFS.m24;
      const muzzle: Vec3 = [bot.at[0], bot.at[1] + 1.5, bot.at[2]];
      if (config.duelBot === 'host') {
        // The bot fights for this player: it kills the guest. One sniper round to the head is lethal.
        link().sendShot(encodeShot({ actor: bot.wire, weapon: 'm24', muzzle, direction: [0, 0, 1], ends: [[muzzle[0], muzzle[1], muzzle[2] + 20]] }));
        link().sendEvent({ t: 'hit', target: peer, attacker: bot.wire, weapon: 'm24', zone: 'head', amount: def.damage * def.headshotMultiplier, p: muzzle, d: [0, 0, 1] });
      } else {
        // The bot fights for the guest: it kills this player, which is the guest's point.
        deaths++;
        link().sendEvent({ t: 'death', victim: me, killer: bot.wire, weapon: 'm24', headshot: true, life, d: [0, 0, 1] });
        life++;
      }
    };

    let last = performance.now();
    const ticker = setInterval(() => {
      if (done) return;
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      if (goAt < 0 && Number.isFinite(inside.goAt) && inside.sync !== null && now >= inside.goAt) {
        goAt = now;
        log('go');
        if (options.role === 'host') {
          for (const bot of fake) link().sendEvent({ t: 'botSpawn', id: bot.wire, name: `Stand-in ${bot.wire}`, weapon: config.mode === 'duel' ? 'm24' : 'm4a1', p: bot.at, yaw: 0 });
        }
      }
      session.update(dt, goAt >= 0);
      if (goAt < 0 || leftAt >= 0) return;
      const elapsed = now - goAt;
      if (deadUntil >= 0 && now >= deadUntil) {
        deadUntil = -1;
        health = 100;
        life++;
      }
      while (statesSent < Math.floor((elapsed * STATE_HZ) / 1000) + 1) sendState(now);
      if (options.role === 'host' && fake.length > 0) {
        while (snapshotsSent < Math.floor((elapsed * BOT_HZ) / 1000) + 1) sendBots(now);
        const kills = options.killFakeAtMs ?? [];
        while (killsDone < kills.length && elapsed >= kills[killsDone]!) {
          const bot = fake.find((b) => b.alive);
          if (bot) killFake(bot, me, 'm4a1');
          killsDone++;
        }
        if (!coop) duelBotAttack(now);
        if (coop && now - lastReport >= REPORT_MS) {
          lastReport = now;
          session.reportMatch(0, fake.filter((b) => b.alive).length, '', fake.filter((b) => !b.alive).length - stand.partnerKills);
        }
      }
      if (options.role === 'guest' && options.killBots && elapsed >= options.killBots.startMs && deadUntil < 0) shootBot(now);
      if (options.leaveAtMs !== undefined && elapsed >= options.leaveAtMs) {
        leftAt = now;
        log('leaving');
        session.leave();
        setTimeout(() => finish(true, 'left the match'), BYE_GRACE_MS);
        return;
      }
      if (elapsed >= options.durationMs) finish(true, 'duration reached');
    }, 4);
    const deadline = setTimeout(() => finish(false, 'timed out'), options.timeoutMs ?? 120_000);

    if (options.role === 'host') {
      session.setConfig(config);
      session.host('room');
    } else {
      readCode((code) => session.join('room', code));
    }
  });
}
