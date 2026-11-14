/**
 * Golden fixtures (PLAN.md 5.4 layer 1): the real TypeScript encoders, validators and pure
 * functions run over fixed and seeded inputs, and their outputs are written for Swift Testing.
 * Inputs mirror the cases in tests/net/*.test.ts, plus seeded fuzz.
 */
import { hashString, seededRandom } from '../../../src/core/random';
import { decodeInvite, encodeInvite, MAX_CODE_CHARS } from '../../../src/net/invite';
import { capDamage, maxHitDamage, sanitizeChat, sanitizeName, TokenBucket, WeaponGate } from '../../../src/net/limits';
import {
  decodeBinary,
  encodeBotSnapshot,
  encodeEvent,
  encodePing,
  encodePlayerState,
  encodePong,
  encodeShot,
  parseEvent,
  type BotState,
  type PlayerState,
  type ShotMessage,
} from '../../../src/net/protocol';
import { MAX_EVENT_CHARS } from '../../../src/net/wire';
import { inviteLink, isRoomCode, makeRoomCode, normalizeRoomCode, roomCodeFrom } from '../../../src/net/room-code';
import { WEAPON_DEFS } from '../../../src/weapons/defs';
import { GRENADE_DEF } from '../../../src/weapons/grenades';
import { WEAPON_IDS } from '../../../src/weapons/models/api';
import type { WeaponDef } from '../../../src/game/contracts';

type Random = () => number;
const hex = (buffer: ArrayBuffer): string => Buffer.from(buffer).toString('hex');
const toBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const fromHex = (text: string): ArrayBuffer => toBuffer(Uint8Array.from(Buffer.from(text.replace(/\s+/g, ''), 'hex')));
/** Doubles JSON cannot carry are written as strings. */
const special = (value: number): number | string => (Number.isFinite(value) ? value : String(value));
const pick = <T>(random: Random, items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const range = (random: Random, min: number, max: number): number => min + random() * (max - min);

// ------------------------------------------------------------------ core

export function coreFixtures(): unknown {
  const seeds = [0, 1, 7, 11, 42, 0x6d2b79f5, 0xffffffff, 123456789, hashString('railyard'), hashString('harbor'), hashString('range')];
  const mulberry32 = seeds.map((seed) => {
    const random = seededRandom(seed);
    return { seed, values: Array.from({ length: 64 }, () => random()) };
  });
  const strings = ['', 'a', 'railyard', 'harbor', 'headworks', 'range', 'Zoë', '日本語', '𝐀𝐁', 'á', '🙂 smile', 'x'.repeat(300)];
  const fnv1a = strings.map((text) => ({ text, hash: hashString(text) }));
  const roundInputs = [0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, -2.4999999999999996, 0.49999999999999994, -0.49999999999999994, 1e15 + 0.5, -1e15 - 0.5, 4503599627370495.5, -4503599627370495.5, 123.456, -123.456, 3.2 * 100, -0.025 * 100, Math.PI * 10000, -32767.5];
  const jsRound = roundInputs.map((x) => ({ x, out: Math.round(x) }));
  const modInputs: [number, number][] = [
    [5.5, 2],
    [-5.5, 2],
    [Math.PI * 6 + 0.3, Math.PI * 2],
    [-Math.PI * 6 - 0.3, Math.PI * 2],
    [-0.1, Math.PI * 2],
    [1e10 + 0.1, 3],
  ];
  const jsMod = modInputs.map(([a, b]) => ({ a, b, out: a % b }));
  const random = seededRandom(5);
  const imul = Array.from({ length: 40 }, () => {
    const a = Math.floor(random() * 4294967296);
    const b = Math.floor(random() * 4294967296);
    return { a, b, out: Math.imul(a, b) >>> 0 };
  });
  return { mulberry32, fnv1a, jsRound, jsMod, imul };
}

// ------------------------------------------------------------------ binary

const baseState = (patch: Partial<PlayerState> = {}): PlayerState => ({
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

const baseBot = (id: number, patch: Partial<BotState> = {}): BotState => ({
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

function randomState(random: Random): PlayerState {
  return {
    seq: Math.floor(random() * 200000),
    time: Math.floor(random() * 1e9) / 4,
    x: range(random, -4000, 4000),
    y: range(random, -50, 200),
    z: range(random, -4000, 4000),
    vx: range(random, -400, 400),
    vy: Math.round(range(random, -2000, 2000)) / 200 + 0.005,
    vz: range(random, -20, 20),
    yaw: range(random, -40, 40),
    pitch: range(random, -2.5, 2.5),
    crouching: random() < 0.5,
    sprinting: random() < 0.5,
    aiming: random() < 0.5,
    alive: random() < 0.5,
    onGround: random() < 0.5,
    reloading: random() < 0.5,
    weapon: pick(random, WEAPON_IDS),
    health: range(random, -20, 140),
    life: Math.floor(random() * 700),
  };
}

function randomBot(random: Random): BotState {
  return {
    id: 2 + Math.floor(random() * 65534),
    x: range(random, -4000, 4000),
    y: range(random, -50, 200),
    z: range(random, -4000, 4000),
    yaw: range(random, -40, 40),
    pitch: range(random, -2, 2),
    speed: range(random, -1, 15),
    crouching: random() < 0.5,
    aiming: random() < 0.5,
    reloading: random() < 0.5,
    alive: random() < 0.5,
    weapon: pick(random, WEAPON_IDS),
  };
}

function randomShot(random: Random): ShotMessage {
  const a = range(random, 0, Math.PI * 2);
  const b = range(random, -1.4, 1.4);
  const point = (): [number, number, number] => [range(random, -4000, 4000), range(random, -50, 200), range(random, -4000, 4000)];
  return {
    actor: Math.floor(random() * 65536),
    weapon: pick(random, WEAPON_IDS),
    muzzle: point(),
    direction: [Math.cos(b) * Math.sin(a), Math.sin(b), Math.cos(b) * Math.cos(a)],
    ends: Array.from({ length: Math.floor(random() * 16) }, point),
  };
}

type EncodeCase =
  | { kind: 'state'; input: PlayerState }
  | { kind: 'bots'; input: { seq: number; time: number; bots: BotState[] } }
  | { kind: 'shot'; input: ShotMessage }
  | { kind: 'ping'; input: { id: number; sentAt: number } }
  | { kind: 'pong'; input: { id: number; sentAt: number; remoteTime: number } };

export function encodeBinary(entry: EncodeCase): ArrayBuffer {
  switch (entry.kind) {
    case 'state':
      return encodePlayerState(entry.input);
    case 'bots':
      return encodeBotSnapshot(entry.input.seq, entry.input.time, entry.input.bots);
    case 'shot':
      return encodeShot(entry.input);
    case 'ping':
      return encodePing(entry.input.id, entry.input.sentAt);
    case 'pong':
      return encodePong(entry.input.id, entry.input.sentAt, entry.input.remoteTime);
  }
}

/** Golden vectors from docs/native-port/maps/net-game.md 4.5, generated from the TS encoders at cbe0add. */
const MAP_GOLDEN: { case: EncodeCase; hex: string }[] = [
  {
    case: {
      kind: 'state',
      input: baseState({ seq: 513, time: 12345.5, x: 1.5, y: 0, z: -2.25, vx: 3.21, vy: -0.5, vz: 0, yaw: 1, pitch: -0.25, crouching: true, sprinting: false, aiming: true, alive: true, onGround: true, reloading: false, weapon: 'm24', health: 87, life: 3 }),
    },
    hex: '01 01 02 00 00 00 00 c0 1c c8 40 00 00 c0 3f 00 00 00 00 00 00 10 c0 41 01 ce ff 00 00 10 27 3c f6 1d 02 57 03',
  },
  {
    case: {
      kind: 'bots',
      input: { seq: 7, time: 1000, bots: [baseBot(5, { x: 10, y: 1, z: -4, yaw: -3, pitch: 0.5, speed: 4.6, crouching: false, aiming: true, reloading: false, alive: true, weapon: 'mp5' })] },
    },
    hex: '02 07 00 00 00 00 00 00 40 8f 40 01 05 00 00 00 20 41 00 00 80 3f 00 00 80 c0 d0 8a 1d 5c 0a 01',
  },
  {
    case: { kind: 'shot', input: { actor: 1, weapon: 'm4a1', muzzle: [0, 1.6, 0], direction: [0, 0, -1], ends: [[0, 1.6, -20]] } },
    hex: '03 01 00 00 00 00 00 00 cd cc cc 3f 00 00 00 00 00 00 00 00 01 80 01 00 00 00 00 cd cc cc 3f 00 00 a0 c1',
  },
  { case: { kind: 'ping', input: { id: 9, sentAt: 250 } }, hex: '04 09 00 00 00 00 00 40 6f 40' },
  { case: { kind: 'pong', input: { id: 9, sentAt: 250, remoteTime: 9000.25 } }, hex: '05 09 00 00 00 00 00 40 6f 40 00 00 00 00 20 94 c1 40' },
];

/** Pull a fuzzed body toward values the decoders accept, so their accepting paths are compared. */
function plausible(bytes: Uint8Array, random: Random): void {
  const view = new DataView(bytes.buffer);
  const coord = (at: number) => view.setFloat32(at, (random() - 0.5) * 9000, true);
  if (bytes[0] === 1) {
    coord(11), coord(15), coord(19);
    bytes[34] = bytes[34]! % 6;
    bytes[35] = bytes[35]! % 101;
  } else if (bytes[0] === 2) {
    for (let at = 12; at < bytes.length; at += 20) {
      view.setUint16(at, 2 + Math.floor(random() * 65534), true);
      coord(at + 2), coord(at + 6), coord(at + 10);
      view.setInt8(at + 16, Math.floor(random() * 181) - 90);
      bytes[at + 19] = bytes[at + 19]! % 6;
    }
  } else if (bytes[0] === 3) {
    bytes[3] = bytes[3]! % 6;
    coord(4), coord(8), coord(12);
    for (let at = 23; at < bytes.length; at += 12) coord(at), coord(at + 4), coord(at + 8);
    if (random() < 0.7) {
      const a = random() * Math.PI * 2;
      const b = (random() - 0.5) * 3;
      view.setInt16(16, Math.round(Math.cos(b) * Math.sin(a) * 32767), true);
      view.setInt16(18, Math.round(Math.sin(b) * 32767), true);
      view.setInt16(20, Math.round(Math.cos(b) * Math.cos(a) * 32767), true);
    }
  }
}

function decoded(buffer: ArrayBuffer): unknown {
  return JSON.parse(JSON.stringify(decodeBinary(buffer)));
}

export function binaryFixtures(): unknown {
  for (const golden of MAP_GOLDEN) {
    const got = hex(encodeBinary(golden.case));
    const want = golden.hex.replace(/\s+/g, '');
    if (got !== want) throw new Error(`net map golden vector for ${golden.case.kind} no longer matches the TS encoder: ${got}`);
  }
  const random = seededRandom(1001);
  const encodeCases: EncodeCase[] = [
    ...MAP_GOLDEN.map((golden) => golden.case),
    { kind: 'state', input: baseState() },
    { kind: 'state', input: baseState({ yaw: Math.PI * 5 + 0.3, health: 250, vx: 9999 }) },
    { kind: 'state', input: baseState({ vx: -0.025, vy: 0.025, vz: -0.015, health: 99.5, pitch: 3, yaw: -Math.PI }) },
    { kind: 'state', input: baseState({ yaw: Math.PI, health: -3, seq: 70000, life: 300 }) },
    { kind: 'bots', input: { seq: 7, time: 5000.5, bots: [baseBot(3), baseBot(4, { alive: false, crouching: true, weapon: 'm249' }), baseBot(900, { speed: 0 })] } },
    { kind: 'bots', input: { seq: 1, time: 10, bots: [] } },
    { kind: 'bots', input: { seq: 65537, time: 99, bots: Array.from({ length: 50 }, (_, i) => randomBot(random)).map((bot, i) => ({ ...bot, id: 2 + i })) } },
    { kind: 'bots', input: { seq: 3, time: 4, bots: [baseBot(2, { pitch: -0.5 * (Math.PI / 180) * 3, speed: 0.025 })] } },
    { kind: 'shot', input: { actor: 1, weapon: 'm24', muzzle: [1, 1.5, -2], direction: [0, 0, -1], ends: [[1, 1.4, -40], [1.5, 1.6, -41]] } },
    { kind: 'shot', input: { actor: 1, weapon: 'm24', muzzle: [1, 1.5, -2], direction: [0, 0, 0], ends: [] } },
    { kind: 'ping', input: { id: 9, sentAt: 100.5 } },
    { kind: 'ping', input: { id: 300, sentAt: 0 } },
    { kind: 'pong', input: { id: 9, sentAt: 100.5, remoteTime: 7000.25 } },
  ];
  for (let i = 0; i < 300; i++) {
    const which = i % 5;
    if (which === 0) encodeCases.push({ kind: 'state', input: randomState(random) });
    else if (which === 1) encodeCases.push({ kind: 'bots', input: { seq: Math.floor(random() * 70000), time: random() * 1e8, bots: Array.from({ length: Math.floor(random() * 6) }, () => randomBot(random)) } });
    else if (which === 2) encodeCases.push({ kind: 'shot', input: randomShot(random) });
    else if (which === 3) encodeCases.push({ kind: 'ping', input: { id: Math.floor(random() * 300), sentAt: random() * 1e9 } });
    else encodeCases.push({ kind: 'pong', input: { id: Math.floor(random() * 300), sentAt: random() * 1e9, remoteTime: random() * 1e9 } });
  }
  const encode = encodeCases.map((entry) => {
    const bytes = encodeBinary(entry);
    return { kind: entry.kind, input: entry.input, hex: hex(bytes), decoded: decoded(bytes) };
  });

  // Decoder cases: mutations from tests/net/protocol.test.ts, truncations, and the seeded fuzz.
  const decodeHex: string[] = [];
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1e7]) {
    const bytes = encodePlayerState(baseState());
    new DataView(bytes).setFloat32(11, bad, true);
    decodeHex.push(hex(bytes));
  }
  {
    const bytes = encodePlayerState(baseState());
    new DataView(bytes).setUint8(34, 200);
    decodeHex.push(hex(bytes));
    const health = encodePlayerState(baseState());
    new DataView(health).setUint8(35, 101);
    decodeHex.push(hex(health));
    const late = encodePlayerState(baseState());
    new DataView(late).setFloat64(3, Number.NaN, true);
    decodeHex.push(hex(late));
    const future = encodePlayerState(baseState());
    new DataView(future).setFloat64(3, 1e12 + 1, true);
    decodeHex.push(hex(future));
    const negative = encodePlayerState(baseState());
    new DataView(negative).setFloat64(3, -1, true);
    decodeHex.push(hex(negative));
    decodeHex.push(hex(encodePlayerState(baseState()).slice(0, 20)));
    decodeHex.push(hex(encodePlayerState(baseState())) + '00');
  }
  {
    const count = encodeBotSnapshot(1, 10, [baseBot(3), baseBot(4)]);
    new DataView(count).setUint8(11, 5);
    decodeHex.push(hex(count));
    const lowId = encodeBotSnapshot(1, 10, [baseBot(3)]);
    new DataView(lowId).setUint16(12, 1, true);
    decodeHex.push(hex(lowId));
    const pitch = encodeBotSnapshot(1, 10, [baseBot(3)]);
    new DataView(pitch).setInt8(12 + 16, -91);
    decodeHex.push(hex(pitch));
    const tooMany = new Uint8Array(12 + 49 * 20);
    tooMany[0] = 2;
    tooMany[11] = 49;
    decodeHex.push(hex(toBuffer(tooMany)));
  }
  {
    const shot: ShotMessage = { actor: 1, weapon: 'm24', muzzle: [1, 1.5, -2], direction: [0, 0, -1], ends: [[1, 1.4, -40]] };
    const many = encodeShot({ ...shot, ends: Array.from({ length: 12 }, () => [0, 0, 0] as const) });
    new DataView(many).setUint8(22, 40);
    decodeHex.push(hex(many));
    const skew = encodeShot(shot);
    new DataView(skew).setInt16(20, -30000, true);
    decodeHex.push(hex(skew));
    const long = encodeShot(shot);
    new DataView(long).setInt16(16, 15000, true);
    decodeHex.push(hex(long));
    const badEnd = encodeShot(shot);
    new DataView(badEnd).setFloat32(23, Number.NaN, true);
    decodeHex.push(hex(badEnd));
  }
  decodeHex.push('', '00', '06', 'ff', '04', '0409000000000000f87f');
  const real = [encodePlayerState(baseState()), encodeBotSnapshot(1, 2, [baseBot(3)]), encodePing(1, 2), encodePong(1, 2, 3), encodeShot({ actor: 0, weapon: 'm4a1', muzzle: [0, 1, 0], direction: [0, 0, 1], ends: [[0, 1, 5]] })];
  for (const bytes of real) for (let cut = 0; cut < bytes.byteLength; cut++) decodeHex.push(hex(bytes.slice(0, cut)));
  const fuzz = seededRandom(42);
  for (let i = 0; i < 4000; i++) {
    const length = Math.floor(fuzz() * 80);
    const bytes = new Uint8Array(length);
    for (let j = 0; j < length; j++) bytes[j] = Math.floor(fuzz() * 256);
    if (length > 0 && fuzz() < 0.8) bytes[0] = 1 + Math.floor(fuzz() * 5);
    decodeHex.push(hex(toBuffer(bytes)));
  }
  // Valid messages with fuzzed bodies, so the accepting paths are compared too.
  for (let i = 0; i < 1000; i++) {
    const length = [37, 12, 32, 52, 23, 35, 47, 10, 18][i % 9]!;
    const bytes = new Uint8Array(length);
    for (let j = 0; j < length; j++) bytes[j] = Math.floor(fuzz() * 256);
    bytes[0] = [1, 2, 2, 2, 3, 3, 3, 4, 5][i % 9]!;
    if (bytes[0] === 2) bytes[11] = (length - 12) / 20;
    if (bytes[0] === 3) bytes[22] = (length - 23) / 12;
    if (bytes[0] !== 3) {
      // A time the decoder accepts: a positive double below 1e12.
      const at = bytes[0] === 4 || bytes[0] === 5 ? 2 : 3;
      new DataView(bytes.buffer).setFloat64(at, fuzz() * 1e9, true);
      if (bytes[0] === 5) new DataView(bytes.buffer).setFloat64(10, fuzz() * 1e9, true);
    }
    if (fuzz() < 0.8) plausible(bytes, fuzz);
    decodeHex.push(hex(toBuffer(bytes)));
  }
  const decode = decodeHex.map((text) => ({ hex: text, decoded: decoded(fromHex(text)) }));
  return { encode, decode };
}

// ------------------------------------------------------------------ events

const CONFIG = { mapId: 'range', mode: 'duel', rules: 'skirmish', difficulty: 'regular', botCount: 0, killTarget: 10, duelBot: 'none' };

export function eventFixtures(): unknown {
  const texts: string[] = [];
  const valid = [
    { t: 'hello', v: 1, name: 'Ada' },
    { t: 'lobby', config: CONFIG },
    { t: 'ready', ready: true },
    { t: 'load', config: CONFIG },
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
    { t: 'nade', p: [1, 1.5, -3], v: [0, 2.8, -15.7] },
    { t: 'boom', p: [1, 0.05, -18] },
    { t: 'hit', target: 5, attacker: 1, weapon: 'grenade', zone: 'torso', amount: 140, p: [1, 2, 3], d: [0, 0, -1] },
    { t: 'death', victim: 1, killer: 1, weapon: 'grenade', headshot: false, life: 2, d: [0, 1, 0] },
    { t: 'ready', ready: false, extra: '<img src=x>' },
    { t: 'lobby', config: { ...CONFIG, duelBot: 'guest' } },
    { t: 'load', config: { mapId: 'range', mode: 'duel', rules: 'skirmish', difficulty: 'regular', botCount: 0, killTarget: 10 } },
    { t: 'hello', v: 1, name: '<b>Ada</b>\u0000 Lovelace the First' },
    { t: 'chat', text: 'on your left' },
    { t: 'chat', text: '<b>hi</b>\n' },
    { t: 'chat', text: '' },
    { t: 'chat', text: 'quote " backslash \\ tab \t bell \u0007 ls   emoji 🙂 nbsp   end' },
    { t: 'hello', v: 4, name: 'Zoë 日本 𝐀𝐁𝐂 á' },
    { t: 'hit', target: 65535, attacker: 0, weapon: 'scarh', zone: 'limb', amount: 1e-7, p: [-5000, 0.1 + 0.2, 1e-7], d: [1.01, -0, 5e-324] },
    { t: 'hit', target: 2, attacker: 3, weapon: 'm7', zone: 'limb', amount: 999.99, p: [123456789e-12, 4999.999999, -1e-6], d: [0.3333333333333333, 0, 1] },
    { t: 'go', at: 1e12 },
    { t: 'go', at: 123456789012.25 },
    { t: 'match', wave: 100000, enemies: 0, result: 'won', hostKills: 3.0, guestKills: 0 },
    { t: 'botSpawn', id: 2, name: '', weapon: 'm249', p: [0, 0, 0], yaw: -10 },
    { t: 'botSpawn', id: 1, name: 'x', weapon: 'm249', p: [0, 0, 0], yaw: 0 },
    { t: 'lobby', config: { ...CONFIG, mapId: 'a'.repeat(24), mode: 'coop', rules: 'survival', difficulty: 'elite', botCount: 32, killTarget: 50, duelBot: 'host' } },
    { t: 'lobby', config: { ...CONFIG, mapId: 'a'.repeat(25) } },
    { t: 'lobby', config: { ...CONFIG, duelBot: null } },
    { t: 'nade', p: [0, 0, 0], v: [40, -40, 40] },
    { t: 'action', actor: 7, weapon: 'm24', stage: 'beltClose' },
    { t: 'away', away: 1 },
    { t: 'bye', reason: 'ended' },
    { t: 'death', victim: 0, killer: 2, weapon: 'm4a1', headshot: 'no', life: 2, d: [0, 0, 1] },
    { t: 'death', victim: 0, killer: 2, weapon: 'm4a1', headshot: false, life: 256, d: [0, 0, 1] },
  ];
  for (const event of valid) texts.push(JSON.stringify(event));
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
    { t: 'lobby', config: { ...CONFIG, mode: 'skirmish' } },
    { t: 'lobby', config: { ...CONFIG, mapId: '../../etc' } },
    { t: 'lobby', config: { ...CONFIG, botCount: 400 } },
    { t: 'lobby', config: { ...CONFIG, killTarget: 0 } },
    { t: 'lobby', config: { ...CONFIG, difficulty: 'god' } },
    { t: 'lobby', config: { ...CONFIG, duelBot: 'both' } },
    { t: 'action', actor: 0, weapon: 'm4a1', stage: 'explode' },
    { t: 'match', wave: -1, enemies: 3, result: '', hostKills: 0, guestKills: 0 },
    { t: 'match', wave: 1, enemies: 3, result: 'draw', hostKills: 0, guestKills: 0 },
    { t: 'bye', reason: 'because' },
    { t: 'nade', p: [1, 1.5, -3] },
    { t: 'nade', p: [1, 1.5, -3], v: [0, 0, -400] },
    { t: 'nade', p: [1, 1.5, 9e9], v: [0, 0, -10] },
    { t: 'boom', p: [1, 'x', 3] },
    { t: 'boom' },
    { t: 'action', actor: 0, weapon: 'grenade', stage: 'magOut' },
    { t: 'switch', weapon: 'grenade' },
  ];
  for (const value of bad) texts.push(JSON.stringify(value));
  texts.push(
    '{not json',
    '',
    ' ',
    '"loaded"',
    '{"t":"loaded"} x',
    '{"t":"loaded",}',
    '{"t":"loaded"}\n',
    ' \t{"t" : "loaded" }\r\n',
    '{"t":"loaded","t":"ready","ready":true}',
    '{"t":"go","at":1e400}',
    '{"t":"loaded","x":1e400}',
    '{"t":"go","at":-0}',
    '{"t":"go","at":01}',
    '{"t":"go","at":1.}',
    '{"t":"go","at":.5}',
    '{"t":"go","at":1E3}',
    '{"t":"go","at":1e-400}',
    '{"t":"match","wave":1.0,"enemies":2e0,"result":"lost","hostKills":0,"guestKills":0}',
    '{"t":"hello","v":1,"name":"\\u0041\\u00e9\\ud835\\udc00"}',
    '{"t":"chat","text":"a\\u0000b\\u200bc\\u202ed"}',
    "{'t':'loaded'}",
    '{"t":"ready","ready":TRUE}',
    '{"t":"loaded"}{"t":"loaded"}',
    ' {"t":"loaded"}',
    '﻿{"t":"loaded"}',
    '[{"t":"loaded"}]',
    '{"t":"chat","text":"line\\nbreak"}',
    '{"t":"chat","text":"raw\ttab"}',
    `{"t":"hello","v":1,"name":"${'x'.repeat(MAX_EVENT_CHARS)}"}`,
    `{"t":"chat","text":"${'y'.repeat(MAX_EVENT_CHARS - 22)}"}`,
    `{"t":"chat","text":"${'y'.repeat(MAX_EVENT_CHARS - 21)}"}`,
    `{"t":"chat","text":"${'🙂'.repeat(1012)}"}`,
  );
  const random = seededRandom(7);
  const junk = (): unknown => pick(random, [null, 1, -1, 1e400, 'x', '', [], {}, true, [1, 2, 3], { length: 3 }, 'm4a1', 'head', 0.5]);
  const types = ['hello', 'lobby', 'ready', 'load', 'loaded', 'go', 'hit', 'death', 'action', 'switch', 'botSpawn', 'match', 'away', 'bye'];
  const keys = ['v', 'name', 'config', 'ready', 'at', 'target', 'attacker', 'weapon', 'zone', 'amount', 'p', 'd', 'victim', 'killer', 'headshot', 'life', 'actor', 'stage', 'id', 'yaw', 'wave', 'enemies', 'result', 'away', 'reason'];
  for (let i = 0; i < 3000; i++) {
    const event: Record<string, unknown> = { t: pick(random, types) };
    for (const key of keys) if (random() < 0.5) event[key] = junk();
    texts.push(JSON.stringify(event));
  }
  // Mostly valid events with numbers that stress JSON number formatting.
  const numbers = (): number => pick(random, [0, -0, 1, 0.1, 1 / 3, 2 / 3, 1e-7, 1.5e-6, 123e-20, 1e21, 1e20, 4999.123456789, -4999.5, 1e300, 5e-324, 86.4, 0.30000000000000004]) * pick(random, [1, -1, 1e-3, 1e3]);
  for (let i = 0; i < 1000; i++) {
    const point = () => [numbers(), numbers(), numbers()];
    const pickType = i % 5;
    const event =
      pickType === 0
        ? { t: 'hit', target: Math.floor(random() * 70000), attacker: Math.floor(random() * 4), weapon: pick(random, [...WEAPON_IDS, 'grenade']), zone: pick(random, ['head', 'torso', 'limb']), amount: Math.abs(numbers()), p: point(), d: [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1] }
        : pickType === 1
          ? { t: 'nade', p: point(), v: [random() * 80 - 40, random() * 80 - 40, random() * 80 - 40] }
          : pickType === 2
            ? { t: 'go', at: Math.abs(numbers()) }
            : pickType === 3
              ? { t: 'botSpawn', id: Math.floor(random() * 70000), name: 'Bot ' + i, weapon: pick(random, WEAPON_IDS), p: point(), yaw: random() * 24 - 12 }
              : { t: 'death', victim: Math.floor(random() * 5), killer: Math.floor(random() * 5), weapon: pick(random, [...WEAPON_IDS, 'grenade']), headshot: random() < 0.5, life: Math.floor(random() * 300), d: [random() * 2 - 1, random() * 2 - 1, random() * 2 - 1] };
    texts.push(JSON.stringify(event));
  }
  return {
    parse: texts.map((text) => {
      const parsed = parseEvent(text);
      return { text, out: parsed === null ? null : encodeEvent(parsed) };
    }),
  };
}

// ------------------------------------------------------------------ limits

/** Code points that exercise the \p{L}, \p{N}, \p{Cc}, \p{Cf} and \s classes. */
const PALETTE = [
  'a', 'Z', '0', '9', ' ', ' ', ' ', '_', '.', "'", '-', '<', '>', '"', '\\', '/', '!', '\t', '\n', '\r', '\u000b', '\u000c',
  '\u0000', '\u0007', '\u007f', '\u0085', ' ', '­', 'é', 'ß', '²', '½', '́', 'А', 'א',
  '٣', 'ก', ' ', '᠎', ' ', ' ', '​', '‌', '‍', ' ', ' ', '‮', ' ',
  ' ', '⁠', 'Ⅷ', '　', 'あ', '日', '﻿', '�', '\u{1d400}', '\u{1d7d8}', '\u{20000}', '\u{1f600}',
  '\u{1f1fa}', '\u{e0001}', '\u{10ffff}',
];

function randomText(random: Random, max: number): string {
  let text = '';
  const length = Math.floor(random() * max);
  for (let i = 0; i < length; i++) text += pick(random, PALETTE);
  return text;
}

const weaponFields = (def: WeaponDef) => ({ id: def.id, damage: def.damage, headshotMultiplier: def.headshotMultiplier, roundsPerMinute: def.roundsPerMinute, pellets: def.pellets });

export function limitFixtures(): unknown {
  const random = seededRandom(23);
  const nameInputs: [string, string | undefined][] = [
    ['Ada', undefined],
    ['Zoë_99', undefined],
    ['<script>x</script>', undefined],
    ['  a \u0000‮  b\n', undefined],
    ['abcdefghijklmnopqrstuvwxyz', undefined],
    ['<<<>>>', undefined],
    ['', 'Friend'],
    ['', 'Soldier'],
    ['𝐀'.repeat(10), undefined],
    ['a' + '𝐀'.repeat(10), undefined],
    ['abcdefghijklmno 𝐀', undefined],
    ['abcdefghijklmnop q', undefined],
    ["O'Brien-Smith Jr.", undefined],
    ['ééé', undefined],
  ];
  for (let i = 0; i < 2000; i++) nameInputs.push([randomText(random, 30), random() < 0.2 ? 'Soldier' : undefined]);
  const names = nameInputs.map(([input, fallback]) => {
    const out = fallback === undefined ? sanitizeName(input) : sanitizeName(input, fallback);
    return { input, fallback: fallback ?? null, out: out.toWellFormed(), wellFormed: out.isWellFormed() };
  });
  const chatInputs = ['  nice shot  ', 'one\ntwo\u0000three​', 'x'.repeat(500), '   ', '<b>hi</b>\n', '🙂'.repeat(100), 'a'.repeat(139) + '🙂', 'a  b﻿c'];
  for (let i = 0; i < 2000; i++) chatInputs.push(randomText(random, 200));
  const chats = chatInputs.map((input) => {
    const out = sanitizeChat(input);
    return { input, out: out.toWellFormed(), wellFormed: out.isWellFormed() };
  });
  const defs: WeaponDef[] = [...WEAPON_IDS.map((id) => WEAPON_DEFS[id]), GRENADE_DEF];
  const amounts = [-4, 0, 1e-9, 12, 27, 86.4, 86.39999999999999, 1000, 10_000, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  const damage = defs.flatMap((def) => [
    { weapon: weaponFields(def), amount: 'max', out: maxHitDamage(def) },
    ...amounts.map((amount) => ({ weapon: weaponFields(def), amount: special(amount), out: capDamage(def, amount) })),
  ]);
  const buckets = [
    { perSecond: 10, size: 3, ops: [[0, 1], [0, 1], [0, 1], [0, 1], [100, 1], [100, 1], [5000, 1]] },
    { perSecond: 10, size: 2, ops: [[60_000, 2], [60_000, 1], [1000, 1]] },
  ];
  for (let i = 0; i < 60; i++) {
    let now = random() * 1000;
    const ops: number[][] = [];
    for (let j = 0; j < 80; j++) {
      now += random() < 0.1 ? -random() * 500 : random() * 120;
      ops.push([now, random() < 0.8 ? 1 : Math.floor(random() * 4)]);
    }
    buckets.push({ perSecond: range(random, 0.5, 40), size: Math.floor(range(random, 1, 30)), ops });
  }
  const tokenBucket = buckets.map((entry) => {
    const bucket = new TokenBucket(entry.perSecond, entry.size);
    return { ...entry, results: entry.ops.map(([now, count]) => bucket.take(now!, count)) };
  });
  const gateDefs: WeaponDef[] = [...defs, { ...WEAPON_DEFS.mp5, pellets: 9 }, { ...WEAPON_DEFS.m24, pellets: 0 }];
  const weaponGate: unknown[] = [];
  for (let i = 0; i < 40; i++) {
    const gate = new WeaponGate();
    let now = random() * 100;
    const ops: { weapon: number; kind: 'shot' | 'hit'; now: number; result: boolean }[] = [];
    for (let j = 0; j < 300; j++) {
      const weapon = Math.floor(random() * gateDefs.length);
      const def = gateDefs[weapon]!;
      now += random() < 0.05 ? -random() * 200 : random() * 40;
      const kind = random() < 0.5 ? 'shot' : 'hit';
      ops.push({ weapon, kind, now, result: kind === 'shot' ? gate.allowShot(def, now) : gate.allowHit(def, now) });
    }
    weaponGate.push({ ops });
  }
  return { names, chats, damage, tokenBucket, weaponGate: { weapons: gateDefs.map(weaponFields), traces: weaponGate } };
}

// ------------------------------------------------------------------ room codes

export function roomFixtures(): unknown {
  const random = seededRandom(31);
  const inputs = [' k7m-2qx ', 'k7m 2qx', 'K7M2Q', 'K7M2QO', ' https://ironvale.n3el.dev/play/?join=abc234 ', 'https://x.dev/play/?q=high&join=ABC-234', 'abc 234', 'abc-234', 'https://example.com/', '', 'x#join=zzz999', '?join=', 'join=ABC234', 'ñandú', 'straße', 'ﬀ', 'ı', 'K7M2QX\u0000', '𝐀BC234'];
  for (let i = 0; i < 300; i++) inputs.push((random() < 0.3 ? 'https://h/?a=b&join=' : '') + randomText(random, 12) + pick(random, ['', 'ABC234', 'k7m-2qx']));
  const text = inputs.map((input) => ({ input, normalized: normalizeRoomCode(input), from: roomCodeFrom(input), isRoomCode: isRoomCode(input) }));
  const make = [0, 1, 2, 3, 99].map((seed) => {
    const source = seededRandom(seed);
    return { seed, codes: Array.from({ length: 20 }, () => makeRoomCode(source)) };
  });
  const links = [
    ['ABC234', 'https://ironvale.n3el.dev/play/?map=harbor#x'],
    ['ABC234', 'https://ironvale.n3el.dev/'],
    ['ABC234', 'https://ironvale.n3el.dev'],
    ['K7M2QX', 'http://localhost:5311/?signal=ws://127.0.0.1:8787&q=high'],
    ['K7M2QX', 'https://ironvale.n3el.dev/a/b/index.html?x=1#join=OLD'],
    ['K7M2QX', 'https://user:pw@ironvale.n3el.dev:8443/p'],
  ].map(([code, page]) => ({ code, page, out: inviteLink(code!, page!) }));
  return { text, make, links };
}

// ------------------------------------------------------------------ invite codes

export const SAMPLE_SDP = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 54321 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 203.0.113.7',
  'a=candidate:1 1 udp 2113937151 0d8e7a1c-1c1f-4a0b-b1b4-2f8c9d6a4e11.local 54321 typ host generation 0 network-cost 999',
  'a=candidate:2 1 udp 1677729535 203.0.113.7 54321 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999',
  'a=ice-ufrag:4ZcD',
  'a=ice-pwd:2/1muCWoOi3uLifh0NuRHlQ1',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n');

export async function inviteFixtures(): Promise<unknown> {
  const offer = await encodeInvite('offer', SAMPLE_SDP);
  const answer = await encodeInvite('answer', SAMPLE_SDP);
  const cases: { text: string; expected: 'offer' | 'answer' }[] = [
    { text: offer, expected: 'offer' },
    { text: answer, expected: 'answer' },
    { text: offer, expected: 'answer' },
    { text: answer, expected: 'offer' },
    { text: `  ${offer.slice(0, 40)}\n${offer.slice(40, 90)} \r\n${offer.slice(90)}\n`, expected: 'offer' },
    { text: '   ', expected: 'offer' },
    { text: 'see you at eight', expected: 'offer' },
    { text: 'K7M2QX', expected: 'offer' },
    { text: offer.slice(0, offer.length - 25), expected: 'offer' },
    { text: offer.slice(0, offer.length - 1), expected: 'offer' },
    { text: offer + 'A', expected: 'offer' },
    { text: offer + 'AA', expected: 'offer' },
    { text: offer + 'AAAA', expected: 'offer' },
    { text: offer + '=', expected: 'offer' },
    { text: `IVH1.${'A'.repeat(MAX_CODE_CHARS)}`, expected: 'offer' },
    { text: `IVH1.${'A'.repeat(MAX_CODE_CHARS - 5)}`, expected: 'offer' },
    { text: 'IVH1.', expected: 'offer' },
    { text: 'IVG1.', expected: 'offer' },
    { text: 'ivh1.abc', expected: 'offer' },
    { text: await encodeInvite('offer', 'v=0\r\n<script>alert(1)</script>\u0007\r\n'), expected: 'offer' },
    { text: await encodeInvite('offer', 'hello there'), expected: 'offer' },
    { text: await encodeInvite('offer', `v=0\r\n${'a=x\r\n'.repeat(40_000)}`), expected: 'offer' },
    { text: await encodeInvite('offer', `v=0\r\n${'a=x\r\n'.repeat(2398)}`), expected: 'offer' },
    { text: await encodeInvite('offer', `v=0\r\n${'a=x\r\n'.repeat(2399)}`), expected: 'offer' },
    { text: await encodeInvite('offer', 'v=0'), expected: 'offer' },
    { text: await encodeInvite('offer', 'v=0\r\né'), expected: 'offer' },
    { text: await encodeInvite('answer', ''), expected: 'answer' },
    { text: 'IVH1.' + Buffer.from('v=0\r\n').toString('base64url'), expected: 'offer' },
    { text: 'IVH1.AwA', expected: 'offer' },
    { text: 'IVH1.A', expected: 'offer' },
  ];
  const random = seededRandom(11);
  const alphabet = 'IVHG1.ABCabc012-_=+/ \n{}<>';
  for (let i = 0; i < 300; i++) {
    let text = random() < 0.5 ? 'IVH1.' : '';
    const length = Math.floor(random() * 200);
    for (let j = 0; j < length; j++) text += alphabet[Math.floor(random() * alphabet.length)];
    cases.push({ text, expected: 'offer' });
  }
  // Random SDP-like text the TS side packs; Swift must unpack every one.
  for (let i = 0; i < 40; i++) {
    let sdp = 'v=0\r\n';
    const lines = Math.floor(random() * 40);
    for (let j = 0; j < lines; j++) sdp += `a=x-${Math.floor(random() * 1e9).toString(36)}:${'z'.repeat(Math.floor(random() * 50))}\r\n`;
    const kind = random() < 0.5 ? 'offer' : 'answer';
    cases.push({ text: await encodeInvite(kind, sdp), expected: random() < 0.85 ? kind : kind === 'offer' ? 'answer' : 'offer' });
  }
  const decode = [];
  for (const entry of cases) decode.push({ ...entry, result: await decodeInvite(entry.text, entry.expected) });
  return { sampleSdp: SAMPLE_SDP, decode };
}
