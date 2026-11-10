import { SPEED } from './body';
import type { Bot } from './bot';
import { coverAgainst } from './cover';
import type { BotEnv } from './env';
import { inCover, inFallback, RETREAT_COVER_RADIUS, startCover, startFallback } from './tactics-cover';
import { inFlank, inHold, inPush, inStrafe, inSuppress, startFlank, startHold, startPush, startStrafe } from './tactics-open';
import { canSeePoint, flatDistance, tacticSeconds, takeFireTurn } from './tactics-util';

const COVER_RADIUS = 12;
const HOLD_COVER_RADIUS = 10;
const RELOAD_COVER_RADIUS = 8;
/** When moving up, cover is searched this far around the point at the soldier's range from the enemy. */
const ADVANCE_RADIUS = 10;
/** A gunner or marksman with no target for this long moves to a better spot. */
const RELOCATE_AFTER = 8;
const SUPPRESS_MIN = 1.2;
const SUPPRESS_SPREAD = 1.5;
/** Below this share of full health a soldier falls back, once. */
const HURT_FRACTION = 0.35;
const HUNT_AFTER = 3;
/** A rusher already this close to its range does not break off to charge again. */
const PUSH_SLACK = 1.3;
const FLANK_MIN_DISTANCE = 12;
/** A soldier who has not seen the enemy for this long gives its turn up. */
const TURN_RELEASE = 1.5;

/** One decision step while the soldier knows about an enemy. */
export function fight(bot: Bot, env: BotEnv, dt: number): void {
  if (!bot.awareness.alerted) {
    // Memory ran out: walk to where the enemy was last and look.
    bot.fireMode = 'none';
    bot.coverNode = -1;
    bot.crouching = false;
    bot.watch = 'none';
    bot.setState('investigate', 'lost the enemy');
    bot.moveTo(bot.lastKnown.x, bot.lastKnown.y, bot.lastKnown.z, SPEED.walk);
    bot.idleTimer = 4;
    return;
  }
  bot.watch = 'enemy';
  if (!bot.targetVisible && bot.unseenTime > TURN_RELEASE) bot.fireTurnUntil = -Infinity;
  bot.fireMode = bot.targetVisible && takeFireTurn(bot, env) ? 'target' : 'none';
  bot.tacticTimer -= dt;
  bot.phaseTimer -= dt;
  if (!bot.fellBack && bot.health < bot.maxHealth * HURT_FRACTION) {
    startFallback(bot, env);
    return;
  }
  // Caught in the open with an empty magazine: reload behind something if it is close.
  const reloading = bot.weapon.reloading;
  if (reloading && !bot.soughtReloadCover && (bot.state === 'strafe' || bot.state === 'hold' || bot.state === 'suppress')) {
    bot.soughtReloadCover = true;
    if (startCover(bot, env, { radius: RELOAD_COVER_RADIUS }, 'reloading')) return;
  }
  if (!reloading) bot.soughtReloadCover = false;
  const rethink = step(bot, env, dt);
  if (rethink !== null) chooseTactic(bot, env, rethink);
}

/** Run the current state for one decision step. A returned reason means: choose again. */
function step(bot: Bot, env: BotEnv, dt: number): string | null {
  switch (bot.state) {
    case 'cover':
      return inCover(bot, env);
    case 'strafe':
      return inStrafe(bot, env);
    case 'push':
      return inPush(bot, env);
    case 'flank':
      return inFlank(bot, env);
    case 'suppress':
      return inSuppress(bot, env);
    case 'fallback':
      return inFallback(bot, env);
    case 'hold':
      return inHold(bot, env, dt);
    default:
      return null;
  }
}

/**
 * Pick what to do next in a fight. Read top to bottom: the first rule that
 * applies wins. The squad blackboard keeps the choices spread out: a share of
 * the squad advances, a few flank once the front is held, the rest fight from
 * cover or in the open.
 */
export function chooseTactic(bot: Bot, env: BotEnv, why: string): void {
  const { squad, random } = env;
  const role = bot.roleDef;
  const profile = bot.profile;
  const distance = flatDistance(bot.position, bot.lastKnown);
  const seen = bot.targetVisible;
  const hit = bot.preferCover;
  const wantCover = hit || random() < profile.coverUse;
  const mayAdvance = bot.state === 'push' || squad.canPush(profile.pushFraction);
  bot.preferCover = false;
  bot.failedPeeks = 0;
  bot.tacticTimer = tacticSeconds(env);

  // Just hit: get behind the nearest thing before anything else.
  if (hit && startCover(bot, env, { radius: COVER_RADIUS }, why)) return;

  // The enemy just ducked out of sight: keep the spot under fire for a moment.
  if (
    !seen &&
    bot.unseenTime > 0.6 &&
    bot.unseenTime < HUNT_AFTER &&
    bot.state !== 'suppress' &&
    bot.role !== 'marksman' &&
    bot.weapon.magazine > 4 &&
    !bot.weapon.reloading &&
    canSeePoint(bot, env, bot.lastKnown, false)
  ) {
    bot.halt();
    bot.phaseTimer = SUPPRESS_MIN + random() * SUPPRESS_SPREAD;
    bot.setState('suppress', why);
    return;
  }

  const lost = !seen && bot.unseenTime > HUNT_AFTER;
  const far = distance > role.maxRange;

  // Marksmen and gunners pick a spot and fight from it; they back off rather than brawl.
  if (role.holds) {
    if (distance < role.minRange) {
      if (!startCover(bot, env, { radius: RETREAT_COVER_RADIUS, range: role.idealRange }, why)) startHold(bot, why);
      return;
    }
    if (far || (!seen && bot.unseenTime > RELOCATE_AFTER)) {
      // No shot from here: move up to a spot that overlooks the enemy's last position.
      const approach = Math.max(role.minRange + 5, Math.min(role.idealRange, distance * 0.7));
      if (startCover(bot, env, { radius: ADVANCE_RADIUS, range: approach, approach, needSight: true }, why)) return;
    }
    const exposed = bot.coverNode < 0 || coverAgainst(env.grid, bot.coverNode, bot.lastKnown.x, bot.lastKnown.z) === 0;
    if (!exposed && bot.state === 'cover') return;
    if (wantCover && startCover(bot, env, { radius: HOLD_COVER_RADIUS, needSight: true }, why)) return;
    startHold(bot, why);
    return;
  }

  // Rushers and breachers close the distance, a few at a time.
  if (role.pushes && distance > role.idealRange * PUSH_SLACK && mayAdvance) {
    startPush(bot, SPEED.run, why);
    return;
  }

  // With the front held by others, go round the side.
  if (
    !role.pushes &&
    bot.state !== 'flank' &&
    distance > FLANK_MIN_DISTANCE &&
    squad.canFlank() &&
    random() < profile.flankChance &&
    startFlank(bot, env, why)
  ) {
    return;
  }

  // Out of touch or out of range. One soldier goes looking; the rest move up to
  // a firing position near their own range, or keep watching if they have one.
  if (lost || far) {
    if (lost && !role.pushes && squad.pushing === 0) {
      startPush(bot, SPEED.jog, why);
      return;
    }
    if (!far && canSeePoint(bot, env, bot.lastKnown, true)) {
      if (bot.state !== 'cover') startHold(bot, why);
      return;
    }
    // A rusher without leave to charge waits at the edge of its range.
    const approach = role.pushes ? role.maxRange : role.idealRange;
    if (startCover(bot, env, { radius: ADVANCE_RADIUS, range: approach, approach, needSight: true }, why)) return;
    if (startCover(bot, env, { radius: ADVANCE_RADIUS, range: approach, approach }, why)) return;
    startHold(bot, why);
    return;
  }

  // In touch and in range: fight from cover near the role's range, or in the open.
  if (wantCover && startCover(bot, env, { radius: COVER_RADIUS, range: role.idealRange }, why)) return;
  startStrafe(bot, why);
}
