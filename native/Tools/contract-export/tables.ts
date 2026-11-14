/**
 * The contract tables (PLAN.md 5.1): everything the native client must agree on with the web
 * build, read from `src/` and `signaling/src` without changing them. Exported values are imported;
 * module-private constants are read with the TypeScript parser (extract-consts.ts).
 */
import { DIFFICULTY, DIFFICULTY_ORDER } from '../../../src/ai/difficulty';
import { ROLES } from '../../../src/ai/roles';
import { PLAYABLE_MAPS } from '../../../src/maps/registry';
import { MAX_KILL_TARGET, MAX_NET_BOTS, GRENADE_SOURCE } from '../../../src/net/events';
import { MAX_CODE_CHARS } from '../../../src/net/invite';
import { CHAT_LENGTH, NAME_LENGTH } from '../../../src/net/limits';
import { JOIN_PARAM, ROOM_ALPHABET, ROOM_CODE_LENGTH } from '../../../src/net/room-code';
import * as wire from '../../../src/net/wire';
import { WEAPON_DEFS } from '../../../src/weapons/defs';
import { GRENADE } from '../../../src/weapons/grenade-math';
import { GRENADE_DEF, GRENADE_ID } from '../../../src/weapons/grenades';
import { WEAPON_IDS } from '../../../src/weapons/models/api';
import { CLOSE, LIMITS } from '../../../signaling/src/room';
import { extractConsts, extractKeys } from './extract-consts';

/** Plain JSON copy; throws on functions, so a def that grows a callback is noticed. */
function data<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, item: unknown) => {
      if (typeof item === 'function') throw new Error(`contract data has a function at ${key}`);
      return item;
    }),
  ) as T;
}

export function protocolTable(repoRoot: string): Record<string, unknown> {
  const x = (file: string, names: string[]) => extractConsts(repoRoot, file, names);
  return {
    protocolVersion: wire.PROTOCOL_VERSION,
    wire: {
      host: wire.WIRE_HOST,
      guest: wire.WIRE_GUEST,
      botBase: wire.WIRE_BOT_BASE,
      maxWireId: wire.MAX_WIRE_ID,
      maxEventChars: wire.MAX_EVENT_CHARS,
      maxPellets: wire.MAX_PELLETS,
      maxBotsPerSnapshot: wire.MAX_BOTS_PER_SNAPSHOT,
      maxCoordinate: wire.MAX_COORDINATE,
      maxTimeMs: wire.MAX_TIME_MS,
    },
    binary: x('src/net/protocol.ts', [
      'TYPE_STATE',
      'TYPE_BOTS',
      'TYPE_SHOT',
      'TYPE_PING',
      'TYPE_PONG',
      'STATE_BYTES',
      'BOTS_HEADER_BYTES',
      'BOT_BYTES',
      'SHOT_HEADER_BYTES',
      'PING_BYTES',
      'PONG_BYTES',
      'ANGLE_SCALE',
      'VELOCITY_SCALE',
      'SPEED_SCALE',
      'DIRECTION_SCALE',
    ]),
    events: {
      maxNetBots: MAX_NET_BOTS,
      maxKillTarget: MAX_KILL_TARGET,
      grenadeSource: GRENADE_SOURCE,
      ...x('src/net/events.ts', [
        'MODES',
        'DUEL_BOTS',
        'RULES',
        'DIFFICULTIES',
        'ZONES',
        'BYE_REASONS',
        'RESULTS',
        'STAGES',
        'MAP_ID',
        'MAX_DAMAGE',
        'MAX_COUNT',
        'MAX_THROW_SPEED',
      ]),
    },
    limits: { nameLength: NAME_LENGTH, chatLength: CHAT_LENGTH, ...x('src/net/limits.ts', ['RATE_SLACK', 'BURST_SECONDS']) },
    room: { alphabet: ROOM_ALPHABET, length: ROOM_CODE_LENGTH, joinParam: JOIN_PARAM },
    invite: { maxCodeChars: MAX_CODE_CHARS, ...x('src/net/invite.ts', ['MAX_SDP_BYTES', 'PREFIX']) },
    timing: {
      match: x('src/net/match.ts', [
        'STATE_INTERVAL',
        'BOT_INTERVAL',
        'PLAYER_DELAY_MS',
        'MAX_EXTRAPOLATION_MS',
        'STALE_MS',
        'NEAR_MISS_RADIUS',
        'GRENADE_REACH',
        'GRENADE_SPEED_SLACK',
      ]),
      session: x('src/net/session.ts', [
        'COUNTDOWN_MS',
        'PEER_TIMEOUT_MS',
        'CONNECT_TIMEOUT_MS',
        'PING_FAST_MS',
        'PING_SLOW_MS',
        'PING_FAST_COUNT',
        'REACHABLE_CACHE_MS',
        'MATCH_REPORT_MS',
        'MAX_QUEUED_EVENTS',
        'SIDE_STEP',
      ]),
      interp: x('src/net/interp.ts', ['DEFAULT_CAPACITY', 'MAX_EXTRAPOLATION_MS']),
      proxies: x('src/net/proxies.ts', ['BOT_DELAY_MS', 'MAX_EXTRAPOLATION_MS', 'CORPSE_SECONDS', 'MAX_PROXIES', 'BOT_RUN_SPEED']),
      clock: x('src/net/clock.ts', ['WINDOW', 'MAX_RTT_MS', 'RTT_SMOOTHING']),
    },
    transport: {
      ...x('src/net/transport.ts', ['GATHER_TIMEOUT_MS', 'STATE_BACKLOG_BYTES', 'EVENT_BACKLOG_BYTES', 'MAX_INCOMING_BYTES']),
      ...x('src/net/signaling.ts', ['MAX_SDP_CHARS', 'MAX_CANDIDATE_CHARS', 'HEALTH_TIMEOUT_MS', 'HOST_CODE_ATTEMPTS']),
      ...x('src/net/ice.ts', ['STUN', 'MAX_EXTRA_SERVERS', 'RELAY_TIMEOUT_MS']),
    },
    storage: x('src/net/session.ts', ['NAME_KEY']),
    relay: { limits: data(LIMITS), close: data(CLOSE) },
  };
}

export function weaponsTable(): Record<string, unknown> {
  return {
    weaponIds: [...WEAPON_IDS],
    weapons: data(WEAPON_IDS.map((id) => WEAPON_DEFS[id])),
    grenadeId: GRENADE_ID,
    grenadeDef: data(GRENADE_DEF),
    grenade: data(GRENADE),
  };
}

export function bodiesTable(repoRoot: string): Record<string, unknown> {
  return {
    hitbox: extractConsts(repoRoot, 'src/game/hitbox.ts', ['STANDING', 'CROUCHING']),
    remote: extractConsts(repoRoot, 'src/net/remote-soldier.ts', ['STAND_EYE', 'CROUCH_EYE', 'CHEST_STAND', 'CHEST_CROUCH']),
    player: extractConsts(repoRoot, 'src/player/controller.ts', ['RADIUS', 'STAND_HEIGHT', 'CROUCH_HEIGHT', 'STAND_EYE', 'CROUCH_EYE']),
    session: extractConsts(repoRoot, 'src/net/session.ts', ['BODY_RADIUS', 'BODY_HEIGHT']),
  };
}

export function aiTable(): Record<string, unknown> {
  return { difficultyOrder: [...DIFFICULTY_ORDER], difficulty: data(DIFFICULTY), roles: data(ROLES) };
}

export function mapsTable(repoRoot: string): Record<string, unknown> {
  const playable = PLAYABLE_MAPS.map((entry) => entry.id);
  const all = extractKeys(repoRoot, 'src/maps/registry.ts', 'LOADERS');
  return { playable, all, developer: all.filter((id) => !playable.includes(id)) };
}
