import { describe, expect, it } from 'vitest';
import { seededRandom } from '../../src/core/random';
import {
  MAX_EVENT_CHARS,
  decodeBinary,
  encodeBotSnapshot,
  encodePing,
  encodePlayerState,
  encodePong,
  encodeShot,
  parseEvent,
  type BotState,
  type PlayerState,
  type ShotMessage,
} from '../../src/net/protocol';

const state = (patch: Partial<PlayerState> = {}): PlayerState => ({
  seq: 513,
  time: 123456.75,
  x: 12.5,
  y: 0.25,
  z: -31.75,
  vx: 3.2,
  vy: -1.5,
  vz: 0.4,
  yaw: 1.25,
  pitch: -0.5,
  crouching: true,
  sprinting: false,
  aiming: true,
  alive: true,
  onGround: true,
  reloading: false,
  weapon: 'm24',
  health: 87,
  life: 3,
  ...patch,
});

const bot = (id: number, patch: Partial<BotState> = {}): BotState => ({
  id,
  x: id * 2,
  y: 0,
  z: -id,
  yaw: 0.5,
  pitch: 0.1,
  speed: 3.4,
  crouching: false,
  aiming: true,
  reloading: false,
  alive: true,
  weapon: 'mp5',
  ...patch,
});

describe('player state', () => {
  it('round trips every field', () => {
    const decoded = decodeBinary(encodePlayerState(state()));
    expect(decoded?.type).toBe('state');
    if (decoded?.type !== 'state') return;
    const got = decoded.state;
    expect(got.seq).toBe(513);
    expect(got.time).toBe(123456.75);
    expect(got.x).toBe(12.5);
    expect(got.z).toBe(-31.75);
    expect(got.vx).toBeCloseTo(3.2, 2);
    expect(got.vy).toBeCloseTo(-1.5, 2);
    expect(got.yaw).toBeCloseTo(1.25, 3);
    expect(got.pitch).toBeCloseTo(-0.5, 3);
    expect(got).toMatchObject({ crouching: true, sprinting: false, aiming: true, alive: true, onGround: true, reloading: false });
    expect(got.weapon).toBe('m24');
    expect(got.health).toBe(87);
    expect(got.life).toBe(3);
  });

  it('is compact', () => {
    expect(encodePlayerState(state()).byteLength).toBeLessThanOrEqual(40);
  });

  it('wraps yaw into one turn and clamps what does not fit', () => {
    const decoded = decodeBinary(encodePlayerState(state({ yaw: Math.PI * 5 + 0.3, health: 250, vx: 9999 })));
    if (decoded?.type !== 'state') throw new Error('expected a state');
    expect(decoded.state.yaw).toBeCloseTo(-Math.PI + 0.3, 3);
    expect(decoded.state.health).toBe(100);
    expect(decoded.state.vx).toBeLessThanOrEqual(327.67);
  });

  it('rejects positions that are not finite or are far outside any map', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1e7]) {
      const bytes = encodePlayerState(state());
      new DataView(bytes).setFloat32(11, bad, true);
      expect(decodeBinary(bytes)).toBeNull();
    }
  });

  it('rejects an unknown weapon, a wrong length and a time that is not finite', () => {
    const bytes = encodePlayerState(state());
    const view = new DataView(bytes);
    const weaponAt = bytes.byteLength - 3;
    view.setUint8(weaponAt, 200);
    expect(decodeBinary(bytes)).toBeNull();
    expect(decodeBinary(encodePlayerState(state()).slice(0, 20))).toBeNull();
    const late = encodePlayerState(state());
    new DataView(late).setFloat64(3, Number.NaN, true);
    expect(decodeBinary(late)).toBeNull();
  });
});

describe('bot snapshot', () => {
  it('round trips a squad', () => {
    const bots = [bot(3), bot(4, { alive: false, crouching: true, weapon: 'm249' }), bot(900, { speed: 0 })];
    const decoded = decodeBinary(encodeBotSnapshot(7, 5000.5, bots));
    if (decoded?.type !== 'bots') throw new Error('expected bots');
    expect(decoded.seq).toBe(7);
    expect(decoded.time).toBe(5000.5);
    expect(decoded.bots.map((entry) => entry.id)).toEqual([3, 4, 900]);
    expect(decoded.bots[1]).toMatchObject({ alive: false, crouching: true, weapon: 'm249' });
    expect(decoded.bots[0]?.speed).toBeCloseTo(3.4, 1);
    expect(decoded.bots[0]?.yaw).toBeCloseTo(0.5, 3);
    expect(decoded.bots[0]?.pitch).toBeCloseTo(0.1, 1);
  });

  it('rejects a count that does not match the length', () => {
    const bytes = encodeBotSnapshot(1, 10, [bot(3), bot(4)]);
    new DataView(bytes).setUint8(11, 5);
    expect(decodeBinary(bytes)).toBeNull();
  });

  it('accepts an empty snapshot', () => {
    const decoded = decodeBinary(encodeBotSnapshot(1, 10, []));
    expect(decoded?.type === 'bots' && decoded.bots.length === 0).toBe(true);
  });
});

describe('shot', () => {
  const shot: ShotMessage = {
    actor: 1,
    weapon: 'r870',
    muzzle: [1, 1.5, -2],
    direction: [0, 0, -1],
    ends: [
      [1, 1.4, -40],
      [1.5, 1.6, -41],
    ],
  };

  it('round trips', () => {
    const decoded = decodeBinary(encodeShot(shot));
    if (decoded?.type !== 'shot') throw new Error('expected a shot');
    expect(decoded.shot.actor).toBe(1);
    expect(decoded.shot.weapon).toBe('r870');
    expect(decoded.shot.muzzle).toEqual([1, 1.5, -2]);
    expect(decoded.shot.direction[2]).toBeCloseTo(-1, 3);
    expect(decoded.shot.ends).toHaveLength(2);
    expect(decoded.shot.ends[1]?.[2]).toBe(-41);
  });

  it('rejects more pellets than any weapon fires and a direction that is not a unit vector', () => {
    const many = encodeShot({ ...shot, ends: Array.from({ length: 12 }, () => [0, 0, 0] as const) });
    new DataView(many).setUint8(22, 40);
    expect(decodeBinary(many)).toBeNull();
    expect(decodeBinary(encodeShot({ ...shot, direction: [0, 0, 0] }))).toBeNull();
  });
});

describe('ping and pong', () => {
  it('round trip', () => {
    expect(decodeBinary(encodePing(9, 100.5))).toEqual({ type: 'ping', id: 9, sentAt: 100.5 });
    expect(decodeBinary(encodePong(9, 100.5, 7000.25))).toEqual({ type: 'pong', id: 9, sentAt: 100.5, remoteTime: 7000.25 });
  });
});

describe('fuzzed binary input', () => {
  it('never throws and never returns values that are not finite', () => {
    const random = seededRandom(42);
    for (let i = 0; i < 4000; i++) {
      const length = Math.floor(random() * 80);
      const bytes = new Uint8Array(length);
      for (let j = 0; j < length; j++) bytes[j] = Math.floor(random() * 256);
      // Bias the first byte toward real message types so the decoders are exercised.
      if (length > 0 && random() < 0.8) bytes[0] = 1 + Math.floor(random() * 5);
      const decoded = decodeBinary(bytes.buffer);
      if (decoded === null) continue;
      const numbers: number[] = [];
      JSON.stringify(decoded, (_key, value: unknown) => {
        if (typeof value === 'number') numbers.push(value);
        return value;
      });
      expect(numbers.every(Number.isFinite)).toBe(true);
    }
  });

  it('rejects truncated copies of real messages', () => {
    const real = [encodePlayerState(state()), encodeBotSnapshot(1, 2, [bot(3)]), encodePing(1, 2), encodePong(1, 2, 3)];
    for (const bytes of real) {
      for (let cut = 0; cut < bytes.byteLength; cut++) expect(decodeBinary(bytes.slice(0, cut))).toBeNull();
    }
  });

  it('ignores things that are not buffers', () => {
    expect(decodeBinary('hello' as unknown as ArrayBuffer)).toBeNull();
    expect(decodeBinary(null as unknown as ArrayBuffer)).toBeNull();
  });
});

describe('events', () => {
  const config = { mapId: 'range', mode: 'duel', rules: 'skirmish', difficulty: 'regular', botCount: 0, killTarget: 10 };

  it('accepts each well-formed event', () => {
    const events = [
      { t: 'hello', v: 1, name: 'Ada' },
      { t: 'lobby', config },
      { t: 'ready', ready: true },
      { t: 'load', config },
      { t: 'loaded' },
      { t: 'go', at: 1234.5 },
      { t: 'hit', target: 1, attacker: 0, weapon: 'm4a1', zone: 'head', amount: 86.4, p: [1, 2, 3], d: [0, 0, -1] },
      { t: 'death', victim: 1, killer: 0, weapon: 'm4a1', headshot: true, life: 2, d: [0, 0, -1] },
      { t: 'action', actor: 0, weapon: 'm4a1', stage: 'magOut' },
      { t: 'switch', weapon: 'mp5' },
      { t: 'botSpawn', id: 17, name: 'Sgt. Hale', weapon: 'm4a1', p: [1, 0, 3], yaw: 1 },
      { t: 'match', wave: 2, enemies: 7, result: '', hostKills: 3, guestKills: 1 },
      { t: 'away', away: true },
      { t: 'bye', reason: 'left' },
    ];
    for (const event of events) expect(parseEvent(JSON.stringify(event))).toEqual(event);
  });

  it('drops unknown fields instead of passing them on', () => {
    const parsed = parseEvent(JSON.stringify({ t: 'ready', ready: false, extra: '<img src=x>' }));
    expect(parsed).toEqual({ t: 'ready', ready: false });
  });

  it('sanitises names', () => {
    const parsed = parseEvent(JSON.stringify({ t: 'hello', v: 1, name: '<b>Ada</b>\u0000 Lovelace the First' }));
    expect(parsed?.t === 'hello' && parsed.name).toBe('bAdab Lovelace t');
  });

  it('rejects malformed events', () => {
    const bad: unknown[] = [
      null,
      42,
      [],
      {},
      { t: 'nope' },
      { t: 'ready', ready: 'yes' },
      { t: 'hello', v: 1 },
      { t: 'go', at: 'soon' },
      { t: 'go', at: Number.MAX_VALUE * 10 },
      { t: 'hit', target: 1, attacker: 0, weapon: 'bfg', zone: 'head', amount: 10, p: [1, 2, 3], d: [0, 0, -1] },
      { t: 'hit', target: 1, attacker: 0, weapon: 'm4a1', zone: 'toe', amount: 10, p: [1, 2, 3], d: [0, 0, -1] },
      { t: 'hit', target: 1, attacker: 0, weapon: 'm4a1', zone: 'head', amount: -5, p: [1, 2, 3], d: [0, 0, -1] },
      { t: 'hit', target: 1, attacker: 0, weapon: 'm4a1', zone: 'head', amount: 10, p: [1, 2], d: [0, 0, -1] },
      { t: 'hit', target: 1.5, attacker: 0, weapon: 'm4a1', zone: 'head', amount: 10, p: [1, 2, 3], d: [0, 0, -1] },
      { t: 'hit', target: 70000, attacker: 0, weapon: 'm4a1', zone: 'head', amount: 10, p: [1, 2, 3], d: [0, 0, -1] },
      { t: 'lobby', config: { ...config, mode: 'skirmish' } },
      { t: 'lobby', config: { ...config, mapId: '../../etc' } },
      { t: 'lobby', config: { ...config, botCount: 400 } },
      { t: 'lobby', config: { ...config, killTarget: 0 } },
      { t: 'lobby', config: { ...config, difficulty: 'god' } },
      { t: 'action', actor: 0, weapon: 'm4a1', stage: 'explode' },
      { t: 'match', wave: -1, enemies: 3, result: '', hostKills: 0, guestKills: 0 },
      { t: 'match', wave: 1, enemies: 3, result: 'draw', hostKills: 0, guestKills: 0 },
      { t: 'bye', reason: 'because' },
    ];
    for (const value of bad) expect(parseEvent(JSON.stringify(value))).toBeNull();
  });

  it('rejects text that is not JSON, is too long, or is not text', () => {
    expect(parseEvent('{not json')).toBeNull();
    expect(parseEvent(JSON.stringify({ t: 'hello', v: 1, name: 'x'.repeat(MAX_EVENT_CHARS) }))).toBeNull();
    expect(parseEvent(new ArrayBuffer(4) as unknown as string)).toBeNull();
  });

  it('survives fuzzed objects', () => {
    const random = seededRandom(7);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const junk = (): unknown => pick([null, 1, -1, 1e400, 'x', '', [], {}, true, [1, 2, 3], { length: 3 }, 'm4a1', 'head', 0.5]);
    const types = ['hello', 'lobby', 'ready', 'load', 'loaded', 'go', 'hit', 'death', 'action', 'switch', 'botSpawn', 'match', 'away', 'bye'];
    const keys = ['v', 'name', 'config', 'ready', 'at', 'target', 'attacker', 'weapon', 'zone', 'amount', 'p', 'd', 'victim', 'killer', 'headshot', 'life', 'actor', 'stage', 'id', 'yaw', 'wave', 'enemies', 'result', 'away', 'reason'];
    for (let i = 0; i < 3000; i++) {
      const event: Record<string, unknown> = { t: pick(types) };
      for (const key of keys) if (random() < 0.5) event[key] = junk();
      expect(() => parseEvent(JSON.stringify(event))).not.toThrow();
    }
  });
});
