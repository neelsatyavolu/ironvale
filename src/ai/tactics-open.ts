import { MathUtils } from 'three/webgpu';
import { SPEED } from './body';
import type { Bot } from './bot';
import type { BotEnv } from './env';
import { flatDistance, lookAround } from './tactics-util';

/**
 * Fighting without cover: strafing, holding a spot, suppressing, advancing
 * and flanking. The `in...` functions run one decision step and return a
 * reason when the soldier should pick a new tactic, or null to carry on.
 */

const LOST_SECONDS = 1.5;
const REPATH_SECONDS = 1.2;
const FLANK_MAX_SECONDS = 25;
const FLANK_ANGLE_MIN = MathUtils.degToRad(75);
const FLANK_ANGLE_SPREAD = MathUtils.degToRad(40);
const avoid = { x: 0, z: 0, radius: 0, cost: 4 };

export function startStrafe(bot: Bot, why: string): void {
  bot.halt();
  bot.coverNode = -1;
  bot.crouching = false;
  bot.phaseTimer = 0;
  bot.setState('strafe', why);
}

/** No cover: keep moving sideways while firing, drifting toward the role's range. */
export function inStrafe(bot: Bot, env: BotEnv): string | null {
  // No cover in reach: take a knee to reload.
  bot.crouching = bot.weapon.reloading;
  if (bot.crouching) return null;
  const lostSight = bot.unseenTime > LOST_SECONDS;
  if (bot.tacticTimer <= 0 || lostSight) return lostSight ? 'lost sight' : 'reposition';
  if (bot.moving || bot.phaseTimer > 0) return null;
  bot.phaseTimer = 0.3 + env.random() * 0.9;
  const grid = env.grid;
  const position = bot.position;
  const dx = bot.lastKnown.x - position.x;
  const dz = bot.lastKnown.z - position.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 1e-3) return null;
  const role = bot.roleDef;
  const advance = distance > role.idealRange + 6 ? 2.5 : distance < role.minRange ? -3 : 0;
  if (env.random() < 0.3) bot.strafeSide = -bot.strafeSide;
  const side = bot.strafeSide * (1.8 + env.random() * 2.2);
  const x = position.x + (dx / distance) * advance - (dz / distance) * side;
  const z = position.z + (dz / distance) * advance + (dx / distance) * side;
  const from = grid.nodeAt(position.x, position.y, position.z);
  const to = grid.nodeAt(x, position.y, z);
  if (from >= 0 && to >= 0 && grid.walkLine(from, to)) bot.moveDirect(x, grid.nodeY[to] ?? position.y, z, SPEED.strafe);
  else bot.strafeSide = -bot.strafeSide;
  return null;
}

export function startHold(bot: Bot, why: string): void {
  bot.halt();
  bot.coverNode = -1;
  bot.setState('hold', why);
}

/** Stay put: a gunner or marksman on its spot, or anyone watching for a lost enemy. */
export function inHold(bot: Bot, env: BotEnv, dt: number): string | null {
  const role = bot.roleDef;
  bot.crouching = role.holds;
  if (!bot.targetVisible && bot.unseenTime > 2) {
    bot.watch = 'none';
    lookAround(bot, env, dt);
  }
  const close = flatDistance(bot.position, bot.lastKnown) < role.minRange;
  // A holder with the enemy in its sights keeps firing from where it is.
  if (role.holds && bot.targetVisible && !close) bot.tacticTimer = Math.max(bot.tacticTimer, 1);
  if (bot.tacticTimer <= 0 || close) return close ? 'enemy close' : bot.targetVisible ? 'reposition' : 'searching';
  return null;
}

export function inSuppress(bot: Bot, env: BotEnv): string | null {
  bot.fireMode = bot.targetVisible ? 'target' : 'lastKnown';
  if (bot.phaseTimer <= 0 || bot.weapon.reloading) return 'done suppressing';
  return null;
}

export function startPush(bot: Bot, speed: number, why: string): void {
  bot.coverNode = -1;
  bot.crouching = false;
  bot.phaseTimer = REPATH_SECONDS;
  bot.setState('push', why);
  bot.moveTo(bot.lastKnown.x, bot.lastKnown.y, bot.lastKnown.z, speed);
}

/** Advance on the last known position until the enemy is in range or the place turns out empty. */
export function inPush(bot: Bot, env: BotEnv): string | null {
  bot.crouching = false;
  const inRange = flatDistance(bot.position, bot.lastKnown) <= bot.roleDef.idealRange;
  if (bot.targetVisible && inRange) return 'in range';
  if (bot.arrived || bot.pathFailed) {
    if (bot.targetVisible) return 'in range';
    startHold(bot, 'searching');
    return null;
  }
  if (bot.phaseTimer > 0) return null;
  bot.phaseTimer = REPATH_SECONDS;
  if (flatDistance(bot.goal, bot.lastKnown) > 3) {
    bot.moveTo(bot.lastKnown.x, bot.lastKnown.y, bot.lastKnown.z, bot.moveSpeed);
  }
  return null;
}

export function startFlank(bot: Bot, env: BotEnv, why: string): boolean {
  const grid = env.grid;
  const tx = bot.lastKnown.x;
  const tz = bot.lastKnown.z;
  const distance = flatDistance(bot.position, bot.lastKnown);
  const bearing = Math.atan2(bot.position.z - tz, bot.position.x - tx);
  const radius = MathUtils.clamp(bot.roleDef.idealRange * 0.7, 8, 18);
  const first = env.random() < 0.5 ? 1 : -1;
  for (let attempt = 0; attempt < 2; attempt++) {
    const side = attempt === 0 ? first : -first;
    const angle = bearing + side * (FLANK_ANGLE_MIN + env.random() * FLANK_ANGLE_SPREAD);
    const node = grid.nearestNode(tx + Math.cos(angle) * radius, bot.lastKnown.y, tz + Math.sin(angle) * radius, 4);
    if (node < 0 || grid.wet[node]) continue;
    bot.coverNode = -1;
    bot.crouching = false;
    bot.setState('flank', why);
    avoid.x = tx;
    avoid.z = tz;
    avoid.radius = Math.min(distance * 0.85, 26);
    bot.moveTo(grid.nodeX(node), grid.nodeY[node] ?? bot.position.y, grid.nodeZ(node), SPEED.run, avoid);
    return true;
  }
  return false;
}

/** Run the long way round; stop when in place, blocked, or face to face with the enemy. */
export function inFlank(bot: Bot, env: BotEnv): string | null {
  const near = bot.targetVisible && flatDistance(bot.position, bot.lastKnown) < bot.roleDef.idealRange * 0.8;
  if (bot.arrived || bot.pathFailed || near || bot.stateTime > FLANK_MAX_SECONDS) {
    return bot.arrived ? 'flank reached' : near ? 'met the enemy' : 'flank abandoned';
  }
  return null;
}
