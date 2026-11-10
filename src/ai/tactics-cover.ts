import { Vector3 } from 'three/webgpu';
import { BODY, SPEED } from './body';
import type { Bot } from './bot';
import { coverAgainst, findCover, type CoverQuery } from './cover';
import type { BotEnv } from './env';
import { flatDistance, tacticSeconds, takeFireTurn } from './tactics-util';

/**
 * Fighting from cover and falling back to it. The `in...` functions run one
 * decision step and return a reason when the soldier should pick a new
 * tactic, or null to carry on.
 */

/** Candidate cover cells checked with rays before giving up. */
const COVER_TRIES = 4;
/** Moves longer than this are jogged, not sprinted. */
const LONG_MOVE = 18;
/** How far a soldier will run for cover when backing off. */
export const RETREAT_COVER_RADIUS = 24;
/** Cover closer to the enemy than this is not cover. */
const MIN_COVER_DISTANCE = 5;
/** An enemy this close flushes a soldier out of cover. */
const FLUSH_DISTANCE = 5;
const HIDE_MIN = 0.7;
const HIDE_SPREAD = 1.3;
const PEEK_MIN = 1.5;
const PEEK_SPREAD = 1.8;
/** A soldier who holds a position stays up this much longer per peek. */
const HOLDER_PEEK_FACTOR = 1.8;
const TOP_UP_FRACTION = 0.4;
const RECOVER_MIN = 5;
const RECOVER_SPREAD = 3;
const RETREAT_DISTANCE = 12;
const TURN_WAIT = 0.5;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const eye = new Vector3();
const point = new Vector3();
const query: Mutable<CoverQuery> = { x: 0, y: 0, z: 0, threatX: 0, threatZ: 0, radius: 0 };
const rejected: number[] = [];

interface CoverOrder {
  /** How far to look, in metres. */
  readonly radius: number;
  /** Prefer spots about this far from the enemy. */
  readonly range?: number;
  /** Centre the search this many metres from the enemy, on the soldier's side, instead of on the soldier. */
  readonly approach?: number;
  /** Only accept spots that overlook the enemy's last position. */
  readonly needSight?: boolean;
}

/** Run to the best cover the order allows. Returns false when there is none. */
export function startCover(bot: Bot, env: BotEnv, order: CoverOrder, why: string): boolean {
  const grid = env.grid;
  const position = bot.position;
  const threat = bot.lastKnown;
  const distance = flatDistance(position, threat);
  const approach = order.approach ?? 0;
  const scale = approach > 0 && distance > approach ? approach / distance : 1;
  query.x = threat.x + (position.x - threat.x) * scale;
  query.y = position.y;
  query.z = threat.z + (position.z - threat.z) * scale;
  query.threatX = threat.x;
  query.threatZ = threat.z;
  query.radius = order.radius;
  query.minThreatDistance = Math.max(MIN_COVER_DISTANCE, bot.roleDef.minRange);
  query.idealThreatDistance = order.range;
  query.taken = env.squad.takenCover;
  query.exclude = bot.coverNode;
  rejected.length = 0;
  query.skip = rejected;
  let node = findCover(grid, query);
  // The masks are a coarse guess; confirm the best few candidates with a ray or two each.
  for (let tries = 1; node >= 0 && !(hides(env, node, threat) && (!order.needSight || overlooks(env, node, threat))); tries++) {
    rejected.push(node);
    node = tries < COVER_TRIES ? findCover(grid, query) : -1;
  }
  if (node < 0) return false;
  bot.coverNode = node;
  bot.phase = 'moving';
  bot.crouching = false;
  bot.setState('cover', why);
  const x = grid.nodeX(node);
  const z = grid.nodeZ(node);
  const speed = Math.hypot(x - position.x, z - position.z) > LONG_MOVE ? SPEED.jog : SPEED.run;
  bot.moveTo(x, grid.nodeY[node] ?? position.y, z, speed);
  return true;
}

/** Up to two rays: is a soldier crouching at `node` out of sight of an enemy standing at `threat`? */
function hides(env: BotEnv, node: number, threat: Vector3): boolean {
  const grid = env.grid;
  const world = env.ctx.world;
  eye.set(grid.nodeX(node), (grid.nodeY[node] ?? 0) + BODY.crouchEye, grid.nodeZ(node));
  point.copy(threat);
  point.y += BODY.standEye;
  if (world.lineOfSight(eye, point)) return false;
  point.y += BODY.chestStand - BODY.standEye;
  return !world.lineOfSight(eye, point);
}

/** One ray: does a soldier standing at (or stepping out from) `node` see the chest-high point above `target`? */
function overlooks(env: BotEnv, node: number, target: Vector3): boolean {
  const grid = env.grid;
  // Tall cover is fought from by stepping round it, which the peek handles; trust it.
  if (coverAgainst(grid, node, target.x, target.z) === 2) return true;
  eye.set(grid.nodeX(node), (grid.nodeY[node] ?? 0) + BODY.standEye, grid.nodeZ(node));
  point.copy(target);
  point.y += BODY.chestStand;
  return env.ctx.world.lineOfSight(eye, point);
}

/** Fight from cover: duck, pop out for a burst or two, duck again. Reload while down. */
export function inCover(bot: Bot, env: BotEnv): string | null {
  const grid = env.grid;
  const weapon = bot.weapon;
  if (bot.phase === 'moving') {
    if (bot.pathFailed) {
      bot.coverNode = -1;
      return 'cover unreachable';
    }
    if (!bot.arrived) return null;
    // Duck now; judge the spot at the next step, once the soldier has looked from down there.
    hide(bot, env);
    return null;
  }
  const kind = coverAgainst(grid, bot.coverNode, bot.lastKnown.x, bot.lastKnown.z);
  const close = flatDistance(bot.position, bot.lastKnown) < FLUSH_DISTANCE;
  // Ducked and still looking the enemy in the eye: this is not cover.
  const exposed = kind === 0 || (bot.phase === 'hiding' && bot.crouching && bot.targetVisible && !bot.moving);
  if (exposed || close || (bot.tacticTimer <= 0 && !weapon.reloading)) {
    return exposed ? 'cover exposed' : close ? 'enemy close' : 'reposition';
  }
  if (weapon.reloading) {
    if (bot.phase !== 'hiding') hide(bot, env);
    return null;
  }
  if (bot.phase === 'hiding') {
    bot.crouching = true;
    bot.fireMode = 'none';
    if (weapon.magazine < weapon.def.magazineSize * TOP_UP_FRACTION) weapon.startReload();
    if (bot.phaseTimer > 0) return null;
    // Wait for a firing turn before showing a head.
    if (!takeFireTurn(bot, env)) {
      bot.phaseTimer = TURN_WAIT;
      return null;
    }
    // Pop out. Low cover: stand up. Tall cover: step round its edge.
    if (kind === 2) {
      const peek = findPeek(bot, env);
      if (peek < 0) {
        if (++bot.failedPeeks >= 2) return 'no firing position';
        bot.phaseTimer = HIDE_MIN;
        return null;
      }
      bot.moveDirect(grid.nodeX(peek), grid.nodeY[peek] ?? bot.position.y, grid.nodeZ(peek), SPEED.strafe);
    }
    const holder = bot.roleDef.holds ? HOLDER_PEEK_FACTOR : 1;
    bot.phase = 'peeking';
    bot.phaseTimer = (PEEK_MIN + env.random() * PEEK_SPREAD) * holder * bot.profile.burstPause;
    bot.crouching = false;
    return null;
  }
  bot.crouching = false;
  if (bot.phaseTimer <= 0) hide(bot, env);
  return null;
}

function hide(bot: Bot, env: BotEnv): void {
  const grid = env.grid;
  bot.phase = 'hiding';
  bot.phaseTimer = (HIDE_MIN + env.random() * HIDE_SPREAD) * bot.profile.burstPause;
  bot.crouching = true;
  bot.fireMode = 'none';
  const node = bot.coverNode;
  if (node < 0) return;
  const x = grid.nodeX(node);
  const z = grid.nodeZ(node);
  if (Math.hypot(x - bot.position.x, z - bot.position.z) > 0.4) {
    bot.moveDirect(x, grid.nodeY[node] ?? bot.position.y, z, SPEED.strafe);
  }
}

/** Nearest cell beside the cover cell from which a standing soldier is no longer hidden. */
function findPeek(bot: Bot, env: BotEnv): number {
  const grid = env.grid;
  const cover = bot.coverNode;
  const cx = grid.nodeX(cover);
  const cz = grid.nodeZ(cover);
  const y = grid.nodeY[cover] ?? 0;
  let best = -1;
  let bestDistance = Infinity;
  for (let iz = -2; iz <= 2; iz++) {
    for (let ix = -2; ix <= 2; ix++) {
      if (ix === 0 && iz === 0) continue;
      const node = grid.nodeAt(cx + ix * grid.cell, y, cz + iz * grid.cell);
      if (node < 0 || Math.abs((grid.nodeY[node] ?? 0) - y) > 0.6) continue;
      const distance = ix * ix + iz * iz;
      if (distance >= bestDistance) continue;
      if (coverAgainst(grid, node, bot.lastKnown.x, bot.lastKnown.z) === 2) continue;
      if (!grid.walkLine(cover, node)) continue;
      bestDistance = distance;
      best = node;
    }
  }
  return best;
}

export function startFallback(bot: Bot, env: BotEnv): void {
  const grid = env.grid;
  const position = bot.position;
  const distance = flatDistance(position, bot.lastKnown);
  bot.fellBack = true;
  bot.fireMode = 'none';
  bot.crouching = false;
  env.callout(bot, 'hurt');
  query.x = position.x;
  query.y = position.y;
  query.z = position.z;
  query.threatX = bot.lastKnown.x;
  query.threatZ = bot.lastKnown.z;
  query.radius = RETREAT_COVER_RADIUS;
  query.minThreatDistance = distance + 2;
  query.idealThreatDistance = distance + RETREAT_DISTANCE;
  query.taken = env.squad.takenCover;
  query.exclude = bot.coverNode;
  let node = findCover(grid, query);
  bot.coverNode = node;
  if (node < 0 && distance > 1e-3) {
    // No cover behind: just get away.
    const scale = RETREAT_DISTANCE / distance;
    node = grid.nearestNode(
      position.x + (position.x - bot.lastKnown.x) * scale,
      position.y,
      position.z + (position.z - bot.lastKnown.z) * scale,
      5,
    );
    if (node >= 0 && grid.wet[node]) node = -1;
  }
  bot.phase = 'moving';
  bot.setState('fallback', 'badly hurt');
  if (node >= 0) bot.moveTo(grid.nodeX(node), grid.nodeY[node] ?? position.y, grid.nodeZ(node), SPEED.run);
  else bot.halt();
}

/** Break contact, get down and stay down for a few seconds, then rejoin the fight from there. */
export function inFallback(bot: Bot, env: BotEnv): string | null {
  const close = bot.targetVisible && flatDistance(bot.position, bot.lastKnown) < 10;
  bot.fireMode = close ? 'target' : 'none';
  if (bot.phase === 'moving') {
    if (bot.moving) return null;
    bot.phase = 'hiding';
    bot.phaseTimer = RECOVER_MIN + env.random() * RECOVER_SPREAD;
    bot.weapon.startReload();
  }
  bot.crouching = true;
  if (bot.phaseTimer > 0) return null;
  if (bot.coverNode < 0) return 'recovered';
  bot.tacticTimer = tacticSeconds(env);
  bot.setState('cover', 'recovered');
  hide(bot, env);
  return null;
}
