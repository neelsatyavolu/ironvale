/**
 * Wire format between the two players.
 *
 * State travels as compact binary on the unreliable channel; shots are binary
 * on the reliable one; everything rare is JSON on the reliable one (see
 * `events.ts`). Every decoder returns null for anything it does not
 * recognise: wrong length, values that are not finite, ids nobody defined.
 * Nothing here throws.
 */
import { WEAPON_IDS, type WeaponId } from '../weapons/models/api';
import { MAX_BOTS_PER_SNAPSHOT, MAX_COORDINATE, MAX_PELLETS, MAX_TIME_MS, WIRE_BOT_BASE, type Vec3 } from './wire';

export * from './events';
export * from './wire';

const TYPE_STATE = 1;
const TYPE_BOTS = 2;
const TYPE_SHOT = 3;
const TYPE_PING = 4;
const TYPE_PONG = 5;

const STATE_BYTES = 37;
const BOTS_HEADER_BYTES = 12;
const BOT_BYTES = 20;
const SHOT_HEADER_BYTES = 23;
const PING_BYTES = 10;
const PONG_BYTES = 18;

const ANGLE_SCALE = 10000;
const VELOCITY_SCALE = 100;
const SPEED_SCALE = 20;
const DIRECTION_SCALE = 32767;
const DEG = Math.PI / 180;

export interface PlayerState {
  /** Wraps at 65536; lets the receiver drop duplicates. */
  readonly seq: number;
  /** Sender's clock, milliseconds. */
  readonly time: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly crouching: boolean;
  readonly sprinting: boolean;
  readonly aiming: boolean;
  readonly alive: boolean;
  readonly onGround: boolean;
  readonly reloading: boolean;
  readonly weapon: WeaponId;
  /** 0 - 100, whole numbers. */
  readonly health: number;
  /** Goes up by one at every respawn, so a respawn is never mistaken for movement. */
  readonly life: number;
}

export interface BotState {
  /** Wire id. */
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  /** Horizontal speed, m/s. */
  readonly speed: number;
  readonly crouching: boolean;
  readonly aiming: boolean;
  readonly reloading: boolean;
  readonly alive: boolean;
  readonly weapon: WeaponId;
}

export interface ShotMessage {
  /** Wire id of the shooter. */
  readonly actor: number;
  readonly weapon: WeaponId;
  readonly muzzle: Vec3;
  readonly direction: Vec3;
  /** Where each projectile stopped. */
  readonly ends: readonly Vec3[];
}

export type BinaryMessage =
  | { readonly type: 'state'; readonly state: PlayerState }
  | { readonly type: 'bots'; readonly seq: number; readonly time: number; readonly bots: readonly BotState[] }
  | { readonly type: 'shot'; readonly shot: ShotMessage }
  | { readonly type: 'ping'; readonly id: number; readonly sentAt: number }
  | { readonly type: 'pong'; readonly id: number; readonly sentAt: number; readonly remoteTime: number };

// ---------------------------------------------------------------- binary

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function wrapAngle(angle: number): number {
  const turn = Math.PI * 2;
  const wrapped = (((angle + Math.PI) % turn) + turn) % turn;
  return wrapped - Math.PI;
}

function int16(value: number, scale: number): number {
  return clamp(Math.round(value * scale), -32767, 32767);
}

function weaponIndex(id: WeaponId): number {
  return Math.max(0, WEAPON_IDS.indexOf(id));
}

function coordinate(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;
}

function timestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_TIME_MS;
}

export function encodePlayerState(state: PlayerState): ArrayBuffer {
  const buffer = new ArrayBuffer(STATE_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, TYPE_STATE);
  view.setUint16(1, state.seq & 0xffff, true);
  view.setFloat64(3, state.time, true);
  view.setFloat32(11, state.x, true);
  view.setFloat32(15, state.y, true);
  view.setFloat32(19, state.z, true);
  view.setInt16(23, int16(state.vx, VELOCITY_SCALE), true);
  view.setInt16(25, int16(state.vy, VELOCITY_SCALE), true);
  view.setInt16(27, int16(state.vz, VELOCITY_SCALE), true);
  view.setInt16(29, int16(wrapAngle(state.yaw), ANGLE_SCALE), true);
  view.setInt16(31, int16(clamp(state.pitch, -Math.PI / 2, Math.PI / 2), ANGLE_SCALE), true);
  view.setUint8(
    33,
    (state.crouching ? 1 : 0) |
      (state.sprinting ? 2 : 0) |
      (state.aiming ? 4 : 0) |
      (state.alive ? 8 : 0) |
      (state.onGround ? 16 : 0) |
      (state.reloading ? 32 : 0),
  );
  view.setUint8(34, weaponIndex(state.weapon));
  view.setUint8(35, clamp(Math.round(state.health), 0, 100));
  view.setUint8(36, state.life & 0xff);
  return buffer;
}

function decodeState(view: DataView): BinaryMessage | null {
  if (view.byteLength !== STATE_BYTES) return null;
  const time = view.getFloat64(3, true);
  const x = view.getFloat32(11, true);
  const y = view.getFloat32(15, true);
  const z = view.getFloat32(19, true);
  const weapon = WEAPON_IDS[view.getUint8(34)];
  const health = view.getUint8(35);
  if (!timestamp(time) || !coordinate(x) || !coordinate(y) || !coordinate(z) || !weapon || health > 100) return null;
  const flags = view.getUint8(33);
  return {
    type: 'state',
    state: {
      seq: view.getUint16(1, true),
      time,
      x,
      y,
      z,
      vx: view.getInt16(23, true) / VELOCITY_SCALE,
      vy: view.getInt16(25, true) / VELOCITY_SCALE,
      vz: view.getInt16(27, true) / VELOCITY_SCALE,
      yaw: wrapAngle(view.getInt16(29, true) / ANGLE_SCALE),
      pitch: clamp(view.getInt16(31, true) / ANGLE_SCALE, -Math.PI / 2, Math.PI / 2),
      crouching: (flags & 1) !== 0,
      sprinting: (flags & 2) !== 0,
      aiming: (flags & 4) !== 0,
      alive: (flags & 8) !== 0,
      onGround: (flags & 16) !== 0,
      reloading: (flags & 32) !== 0,
      weapon,
      health,
      life: view.getUint8(36),
    },
  };
}

/** At most `MAX_BOTS_PER_SNAPSHOT` bots; send a larger squad as several snapshots. */
export function encodeBotSnapshot(seq: number, time: number, bots: readonly BotState[]): ArrayBuffer {
  const count = Math.min(bots.length, MAX_BOTS_PER_SNAPSHOT);
  const buffer = new ArrayBuffer(BOTS_HEADER_BYTES + count * BOT_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, TYPE_BOTS);
  view.setUint16(1, seq & 0xffff, true);
  view.setFloat64(3, time, true);
  view.setUint8(11, count);
  for (let i = 0; i < count; i++) {
    const bot = bots[i]!;
    const at = BOTS_HEADER_BYTES + i * BOT_BYTES;
    view.setUint16(at, bot.id & 0xffff, true);
    view.setFloat32(at + 2, bot.x, true);
    view.setFloat32(at + 6, bot.y, true);
    view.setFloat32(at + 10, bot.z, true);
    view.setInt16(at + 14, int16(wrapAngle(bot.yaw), ANGLE_SCALE), true);
    view.setInt8(at + 16, clamp(Math.round(bot.pitch / DEG), -90, 90));
    view.setUint8(at + 17, clamp(Math.round(bot.speed * SPEED_SCALE), 0, 255));
    view.setUint8(at + 18, (bot.crouching ? 1 : 0) | (bot.aiming ? 2 : 0) | (bot.reloading ? 4 : 0) | (bot.alive ? 8 : 0));
    view.setUint8(at + 19, weaponIndex(bot.weapon));
  }
  return buffer;
}

function decodeBots(view: DataView): BinaryMessage | null {
  if (view.byteLength < BOTS_HEADER_BYTES) return null;
  const count = view.getUint8(11);
  const time = view.getFloat64(3, true);
  if (count > MAX_BOTS_PER_SNAPSHOT || view.byteLength !== BOTS_HEADER_BYTES + count * BOT_BYTES || !timestamp(time)) return null;
  const bots: BotState[] = [];
  for (let i = 0; i < count; i++) {
    const at = BOTS_HEADER_BYTES + i * BOT_BYTES;
    const id = view.getUint16(at, true);
    const x = view.getFloat32(at + 2, true);
    const y = view.getFloat32(at + 6, true);
    const z = view.getFloat32(at + 10, true);
    const pitch = view.getInt8(at + 16);
    const weapon = WEAPON_IDS[view.getUint8(at + 19)];
    if (id < WIRE_BOT_BASE || !coordinate(x) || !coordinate(y) || !coordinate(z) || pitch < -90 || pitch > 90 || !weapon) return null;
    const flags = view.getUint8(at + 18);
    bots.push({
      id,
      x,
      y,
      z,
      yaw: wrapAngle(view.getInt16(at + 14, true) / ANGLE_SCALE),
      pitch: pitch * DEG,
      speed: view.getUint8(at + 17) / SPEED_SCALE,
      crouching: (flags & 1) !== 0,
      aiming: (flags & 2) !== 0,
      reloading: (flags & 4) !== 0,
      alive: (flags & 8) !== 0,
      weapon,
    });
  }
  return { type: 'bots', seq: view.getUint16(1, true), time, bots };
}

export function encodeShot(shot: ShotMessage): ArrayBuffer {
  const count = Math.min(shot.ends.length, MAX_PELLETS);
  const buffer = new ArrayBuffer(SHOT_HEADER_BYTES + count * 12);
  const view = new DataView(buffer);
  view.setUint8(0, TYPE_SHOT);
  view.setUint16(1, shot.actor & 0xffff, true);
  view.setUint8(3, weaponIndex(shot.weapon));
  view.setFloat32(4, shot.muzzle[0], true);
  view.setFloat32(8, shot.muzzle[1], true);
  view.setFloat32(12, shot.muzzle[2], true);
  view.setInt16(16, int16(shot.direction[0], DIRECTION_SCALE), true);
  view.setInt16(18, int16(shot.direction[1], DIRECTION_SCALE), true);
  view.setInt16(20, int16(shot.direction[2], DIRECTION_SCALE), true);
  view.setUint8(22, count);
  for (let i = 0; i < count; i++) {
    const end = shot.ends[i]!;
    const at = SHOT_HEADER_BYTES + i * 12;
    view.setFloat32(at, end[0], true);
    view.setFloat32(at + 4, end[1], true);
    view.setFloat32(at + 8, end[2], true);
  }
  return buffer;
}

function readPoint(view: DataView, at: number): Vec3 | null {
  const x = view.getFloat32(at, true);
  const y = view.getFloat32(at + 4, true);
  const z = view.getFloat32(at + 8, true);
  return coordinate(x) && coordinate(y) && coordinate(z) ? [x, y, z] : null;
}

function decodeShot(view: DataView): BinaryMessage | null {
  if (view.byteLength < SHOT_HEADER_BYTES) return null;
  const count = view.getUint8(22);
  if (count > MAX_PELLETS || view.byteLength !== SHOT_HEADER_BYTES + count * 12) return null;
  const weapon = WEAPON_IDS[view.getUint8(3)];
  const muzzle = readPoint(view, 4);
  if (!weapon || !muzzle) return null;
  const dx = view.getInt16(16, true) / DIRECTION_SCALE;
  const dy = view.getInt16(18, true) / DIRECTION_SCALE;
  const dz = view.getInt16(20, true) / DIRECTION_SCALE;
  const length = Math.hypot(dx, dy, dz);
  if (length < 0.9 || length > 1.1) return null;
  const ends: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const end = readPoint(view, SHOT_HEADER_BYTES + i * 12);
    if (!end) return null;
    ends.push(end);
  }
  return {
    type: 'shot',
    shot: { actor: view.getUint16(1, true), weapon, muzzle, direction: [dx / length, dy / length, dz / length], ends },
  };
}

export function encodePing(id: number, sentAt: number): ArrayBuffer {
  const buffer = new ArrayBuffer(PING_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, TYPE_PING);
  view.setUint8(1, id & 0xff);
  view.setFloat64(2, sentAt, true);
  return buffer;
}

export function encodePong(id: number, sentAt: number, remoteTime: number): ArrayBuffer {
  const buffer = new ArrayBuffer(PONG_BYTES);
  const view = new DataView(buffer);
  view.setUint8(0, TYPE_PONG);
  view.setUint8(1, id & 0xff);
  view.setFloat64(2, sentAt, true);
  view.setFloat64(10, remoteTime, true);
  return buffer;
}

export function decodeBinary(data: unknown): BinaryMessage | null {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 1) return null;
  const view = new DataView(data);
  switch (view.getUint8(0)) {
    case TYPE_STATE:
      return decodeState(view);
    case TYPE_BOTS:
      return decodeBots(view);
    case TYPE_SHOT:
      return decodeShot(view);
    case TYPE_PING: {
      if (view.byteLength !== PING_BYTES) return null;
      const sentAt = view.getFloat64(2, true);
      return timestamp(sentAt) ? { type: 'ping', id: view.getUint8(1), sentAt } : null;
    }
    case TYPE_PONG: {
      if (view.byteLength !== PONG_BYTES) return null;
      const sentAt = view.getFloat64(2, true);
      const remoteTime = view.getFloat64(10, true);
      return timestamp(sentAt) && timestamp(remoteTime) ? { type: 'pong', id: view.getUint8(1), sentAt, remoteTime } : null;
    }
    default:
      return null;
  }
}
