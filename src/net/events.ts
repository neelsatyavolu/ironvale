/**
 * The rare messages between the two players: lobby, hits, deaths, match
 * state. JSON on the reliable channel. `parseEvent` rebuilds each one field
 * by field and returns null for anything malformed.
 */
import type { Difficulty } from '../core/settings';
import type { HitZone, WeaponActionStage } from '../game/contracts';
import { WEAPON_IDS, type WeaponId } from '../weapons/models/api';
import { sanitizeName } from './limits';
import { MAX_COORDINATE, MAX_EVENT_CHARS, MAX_TIME_MS, MAX_WIRE_ID, WIRE_BOT_BASE, type Vec3 } from './wire';


export type NetMode = 'coop' | 'duel';
export type NetRules = 'skirmish' | 'survival';

/** What the host chooses in the lobby. */
export interface NetMatchConfig {
  readonly mapId: string;
  readonly mode: NetMode;
  /** Co-op only: which single-player rules the pair plays under. */
  readonly rules: NetRules;
  readonly difficulty: Difficulty;
  readonly botCount: number;
  /** Duel only: kills needed to win. */
  readonly killTarget: number;
}

export type ByeReason = 'left' | 'timeout' | 'ended';

export type NetEvent =
  | { readonly t: 'hello'; readonly v: number; readonly name: string }
  | { readonly t: 'lobby'; readonly config: NetMatchConfig }
  | { readonly t: 'ready'; readonly ready: boolean }
  | { readonly t: 'load'; readonly config: NetMatchConfig }
  | { readonly t: 'loaded' }
  /** Start time on the host's clock, milliseconds. */
  | { readonly t: 'go'; readonly at: number }
  | {
      readonly t: 'hit';
      readonly target: number;
      readonly attacker: number;
      readonly weapon: WeaponId;
      readonly zone: HitZone;
      readonly amount: number;
      readonly p: Vec3;
      readonly d: Vec3;
    }
  | {
      readonly t: 'death';
      readonly victim: number;
      readonly killer: number;
      readonly weapon: WeaponId;
      readonly headshot: boolean;
      readonly life: number;
      readonly d: Vec3;
    }
  | { readonly t: 'action'; readonly actor: number; readonly weapon: WeaponId; readonly stage: WeaponActionStage }
  | { readonly t: 'switch'; readonly weapon: WeaponId }
  | { readonly t: 'botSpawn'; readonly id: number; readonly name: string; readonly weapon: WeaponId; readonly p: Vec3; readonly yaw: number }
  | {
      readonly t: 'match';
      readonly wave: number;
      readonly enemies: number;
      readonly result: '' | 'won' | 'lost';
      readonly hostKills: number;
      readonly guestKills: number;
    }
  | { readonly t: 'away'; readonly away: boolean }
  | { readonly t: 'bye'; readonly reason: ByeReason };

const MODES: readonly NetMode[] = ['coop', 'duel'];
const RULES: readonly NetRules[] = ['skirmish', 'survival'];
const DIFFICULTIES: readonly Difficulty[] = ['recruit', 'regular', 'veteran', 'elite'];
const ZONES: readonly HitZone[] = ['head', 'torso', 'limb'];
const BYE_REASONS: readonly ByeReason[] = ['left', 'timeout', 'ended'];
const RESULTS = ['', 'won', 'lost'] as const;
const STAGES: readonly WeaponActionStage[] = [
  'magOut',
  'magIn',
  'boltBack',
  'boltForward',
  'boltLift',
  'boltClose',
  'shellInsert',
  'beltOpen',
  'beltClose',
];
const MAP_ID = /^[a-z0-9-]{1,24}$/;
export const MAX_NET_BOTS = 32;
export const MAX_KILL_TARGET = 50;
const MAX_DAMAGE = 1000;
const MAX_COUNT = 100000;

type Fields = Record<string, unknown>;

function oneOf<T extends string>(value: unknown, options: readonly T[]): T | null {
  return typeof value === 'string' && (options as readonly string[]).includes(value) ? (value as T) : null;
}

function whole(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function real(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function wireId(value: unknown): number | null {
  return whole(value, 0, MAX_WIRE_ID);
}

function point(value: unknown, limit: number): Vec3 | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const x = real(value[0], -limit, limit);
  const y = real(value[1], -limit, limit);
  const z = real(value[2], -limit, limit);
  return x === null || y === null || z === null ? null : [x, y, z];
}

function weaponId(value: unknown): WeaponId | null {
  return oneOf(value, WEAPON_IDS);
}

function matchConfig(value: unknown): NetMatchConfig | null {
  if (typeof value !== 'object' || value === null) return null;
  const fields = value as Fields;
  const mapId = typeof fields.mapId === 'string' && MAP_ID.test(fields.mapId) ? fields.mapId : null;
  const mode = oneOf(fields.mode, MODES);
  const rules = oneOf(fields.rules, RULES);
  const difficulty = oneOf(fields.difficulty, DIFFICULTIES);
  const botCount = whole(fields.botCount, 0, MAX_NET_BOTS);
  const killTarget = whole(fields.killTarget, 1, MAX_KILL_TARGET);
  if (mapId === null || !mode || !rules || !difficulty || botCount === null || killTarget === null) return null;
  return { mapId, mode, rules, difficulty, botCount, killTarget };
}

function build(fields: Fields): NetEvent | null {
  switch (fields.t) {
    case 'hello': {
      const v = whole(fields.v, 0, 1000);
      if (v === null || typeof fields.name !== 'string') return null;
      return { t: 'hello', v, name: sanitizeName(fields.name) };
    }
    case 'lobby':
    case 'load': {
      const config = matchConfig(fields.config);
      return config ? { t: fields.t, config } : null;
    }
    case 'ready':
      return typeof fields.ready === 'boolean' ? { t: 'ready', ready: fields.ready } : null;
    case 'loaded':
      return { t: 'loaded' };
    case 'go': {
      const at = real(fields.at, 0, MAX_TIME_MS);
      return at === null ? null : { t: 'go', at };
    }
    case 'hit': {
      const target = wireId(fields.target);
      const attacker = wireId(fields.attacker);
      const weapon = weaponId(fields.weapon);
      const zone = oneOf(fields.zone, ZONES);
      const amount = real(fields.amount, 0, MAX_DAMAGE);
      const p = point(fields.p, MAX_COORDINATE);
      const d = point(fields.d, 1.01);
      if (target === null || attacker === null || !weapon || !zone || amount === null || !p || !d) return null;
      return { t: 'hit', target, attacker, weapon, zone, amount, p, d };
    }
    case 'death': {
      const victim = wireId(fields.victim);
      const killer = wireId(fields.killer);
      const weapon = weaponId(fields.weapon);
      const life = whole(fields.life, 0, 255);
      const d = point(fields.d, 1.01);
      if (victim === null || killer === null || !weapon || typeof fields.headshot !== 'boolean' || life === null || !d) return null;
      return { t: 'death', victim, killer, weapon, headshot: fields.headshot, life, d };
    }
    case 'action': {
      const actor = wireId(fields.actor);
      const weapon = weaponId(fields.weapon);
      const stage = oneOf(fields.stage, STAGES);
      return actor === null || !weapon || !stage ? null : { t: 'action', actor, weapon, stage };
    }
    case 'switch': {
      const weapon = weaponId(fields.weapon);
      return weapon ? { t: 'switch', weapon } : null;
    }
    case 'botSpawn': {
      const id = whole(fields.id, WIRE_BOT_BASE, MAX_WIRE_ID);
      const weapon = weaponId(fields.weapon);
      const p = point(fields.p, MAX_COORDINATE);
      const yaw = real(fields.yaw, -10, 10);
      if (id === null || typeof fields.name !== 'string' || !weapon || !p || yaw === null) return null;
      return { t: 'botSpawn', id, name: sanitizeName(fields.name, 'Soldier'), weapon, p, yaw };
    }
    case 'match': {
      const wave = whole(fields.wave, 0, MAX_COUNT);
      const enemies = whole(fields.enemies, 0, MAX_COUNT);
      const result = oneOf(fields.result, RESULTS);
      const hostKills = whole(fields.hostKills, 0, MAX_COUNT);
      const guestKills = whole(fields.guestKills, 0, MAX_COUNT);
      if (wave === null || enemies === null || result === null || hostKills === null || guestKills === null) return null;
      return { t: 'match', wave, enemies, result, hostKills, guestKills };
    }
    case 'away':
      return typeof fields.away === 'boolean' ? { t: 'away', away: fields.away } : null;
    case 'bye': {
      const reason = oneOf(fields.reason, BYE_REASONS);
      return reason ? { t: 'bye', reason } : null;
    }
    default:
      return null;
  }
}

/**
 * Parse and validate one event. The result is rebuilt field by field, so
 * nothing the sender added beyond the known fields survives.
 */
export function parseEvent(text: unknown): NetEvent | null {
  if (typeof text !== 'string' || text.length > MAX_EVENT_CHARS) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  return build(data as Fields);
}

export function encodeEvent(event: NetEvent): string {
  return JSON.stringify(event);
}
