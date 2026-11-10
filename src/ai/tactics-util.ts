import { Vector3 } from 'three/webgpu';
import { BODY } from './body';
import { wrapAngle, type Bot } from './bot';
import type { BotEnv } from './env';

/** Seconds a tactic lasts before the soldier thinks again and usually moves. */
const TACTIC_MIN = 3.5;
const TACTIC_SPREAD = 4;
/** A firing turn lasts this long, then the soldier rests if others are waiting. */
const TURN_MIN = 4;
const TURN_SPREAD = 3;
const TURN_REST = 2;

const eye = new Vector3();
const point = new Vector3();

export function flatDistance(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** How long to stay with a newly chosen tactic. */
export function tacticSeconds(env: BotEnv): number {
  return TACTIC_MIN + env.random() * TACTIC_SPREAD;
}

/** Turn the head now and then while standing. */
export function lookAround(bot: Bot, env: BotEnv, dt: number): void {
  bot.scanTimer -= dt;
  if (bot.scanTimer > 0) return;
  bot.scanTimer = 1.2 + env.random() * 2.2;
  bot.restYaw = wrapAngle(bot.restYaw + (env.random() - 0.5) * 2.6);
}

/**
 * Only so many soldiers fire at once (fewer on easier settings); the others
 * keep their heads down until a turn frees up. A turn lasts a few seconds,
 * then the soldier steps back for a moment if others are waiting.
 */
export function takeFireTurn(bot: Bot, env: BotEnv): boolean {
  const { squad, time } = env;
  if (bot.fireTurnUntil > time) return true;
  const cap = bot.profile.attackers;
  const contested = squad.engaging + squad.pushing + squad.flanking > cap;
  if (squad.firing >= cap || (contested && time < bot.fireTurnAgain)) return false;
  bot.fireTurnUntil = time + TURN_MIN + env.random() * TURN_SPREAD;
  bot.fireTurnAgain = bot.fireTurnUntil + TURN_REST;
  squad.firing++;
  return true;
}

/** One ray: can the soldier (as it is, or standing up) see the chest-high point above `position`? */
export function canSeePoint(bot: Bot, env: BotEnv, position: Vector3, standing: boolean): boolean {
  point.copy(position);
  point.y += BODY.chestStand;
  bot.eyePosition(eye);
  if (standing) eye.y = bot.position.y + BODY.standEye;
  return env.ctx.world.lineOfSight(eye, point);
}
