import { Vector3 } from 'three/webgpu';
import { BODY, SPEED } from './body';
import type { Bot } from './bot';
import type { BotEnv } from './env';
import { effectiveVisionRange, inVisionCone, VISION } from './perception';
import { chooseTactic, fight } from './tactics';
import { lookAround } from './tactics-util';

/** A hit tells the soldier roughly where it came from, to within this many metres. */
const HIT_GUESS_ERROR = 3;
/** Error on a heard position, as a share of the distance to it. */
const NOISE_ERROR_FRACTION = 0.1;
/** A sighting goes out over the radio: it reaches mates this far away, after this delay. */
const RADIO_RANGE = 150;
const RADIO_DELAY = 0.7;
const SHARE_INTERVAL = 0.4;
/** After a hit the current tactic is reconsidered this soon. */
const HIT_REACTION = 0.25;
const PATROL_RADIUS_MIN = 4;
const PATROL_RADIUS_SPREAD = 8;
const INVESTIGATE_SECONDS = 4;
const SWEEP_JOG_BIAS = 0.3;

const eye = new Vector3();
const head = new Vector3();
const chest = new Vector3();

/**
 * One decision step for one soldier, run six to eight times a second: sense,
 * then act on the current state. Everything between decisions (walking,
 * turning, firing bursts) is carried out every frame by `Bot.update`.
 */
export function think(bot: Bot, env: BotEnv, dt: number): void {
  sense(bot, env, dt);
  if (bot.inCombat) fight(bot, env, dt);
  else if (bot.awareness.alerted) {
    bot.watch = 'enemy';
    chooseTactic(bot, env, bot.targetVisible ? 'enemy spotted' : 'alerted');
  } else roam(bot, env, dt);
}

// ---------------------------------------------------------------- senses

function sense(bot: Bot, env: BotEnv, dt: number): void {
  const profile = bot.profile;
  const world = env.ctx.world;
  const target = nearestEnemy(bot, env);
  if (target !== bot.target) {
    bot.target = target;
    bot.aim.reset();
  }

  // Sight: cone and range first, then up to two rays (chest, head).
  let inView = false;
  let distance = Infinity;
  if (target) {
    bot.eyePosition(eye);
    chest.copy(target.position);
    chest.y += target.crouching ? BODY.chestCrouch : BODY.chestStand;
    distance = eye.distanceTo(chest);
    const targetSpeed = Math.hypot(target.velocity.x, target.velocity.z);
    const range = effectiveVisionRange(profile.visionRange, env.fogDensity, target.crouching, targetSpeed);
    const half = bot.awareness.alerted ? VISION.halfAngleAlert : VISION.halfAngleCalm;
    if (distance < VISION.proximity || inVisionCone(eye.x, eye.y, eye.z, bot.yaw, chest.x, chest.y, chest.z, half, range)) {
      // Chest first; when only the head shows over cover, that is what gets aimed at.
      const chestInView = world.lineOfSight(eye, chest);
      inView = chestInView || world.lineOfSight(eye, target.eyePosition(head));
      bot.aimAtHead = inView && !chestInView;
    }
  }
  const wasAlerted = bot.awareness.alerted;
  // Distant targets take longer to pick out.
  const reaction = profile.reactionTime * (0.75 + 0.5 * Math.min(1, distance / profile.visionRange));
  bot.awareness.update(dt, inView, reaction, profile.memorySeconds);
  bot.targetVisible = bot.awareness.canEngage;

  if (bot.targetVisible && target) {
    if (bot.unseenTime > 2) bot.aim.reset();
    bot.unseenTime = 0;
    bot.lastKnown.copy(target.position);
    bot.infoTime = env.time;
    env.squad.report(bot.id, bot.position, target.position, env.time);
    if (!wasAlerted) env.callout(bot, 'spotted');
  } else if (!(bot.phase === 'hiding' && (bot.state === 'cover' || bot.state === 'fallback'))) {
    // Time with eyes up and nothing to see. Ducking behind cover by choice does not count.
    bot.unseenTime += dt;
  }

  // Pain: the soldier learns roughly where the shot came from.
  if (bot.hitPending) {
    bot.hitPending = false;
    bot.preferCover = true;
    bot.tacticTimer = Math.min(bot.tacticTimer, HIT_REACTION);
    if (!bot.targetVisible) learn(bot, env, bot.hitFrom, HIT_GUESS_ERROR);
    env.callout(bot, 'hurt');
  }

  // Hearing.
  if (bot.noisePending) {
    bot.noisePending = false;
    const underFire = bot.noiseKind === 'nearMiss' || bot.noiseKind === 'impact';
    if (bot.targetVisible) {
      if (underFire) bot.tacticTimer = Math.min(bot.tacticTimer, 1);
    } else if (bot.awareness.alerted || underFire) {
      learn(bot, env, bot.noisePoint, bot.position.distanceTo(bot.noisePoint) * NOISE_ERROR_FRACTION);
    } else {
      bot.investigatePending = true;
    }
  }

  // The squad: a mate's sighting reaches the others a moment later.
  const squad = env.squad;
  if (
    !bot.targetVisible &&
    squad.spotterId !== bot.id &&
    squad.contactTime > bot.infoTime + SHARE_INTERVAL &&
    env.time - squad.contactStart >= RADIO_DELAY &&
    bot.position.distanceToSquared(squad.spotterPosition) < RADIO_RANGE * RADIO_RANGE
  ) {
    bot.lastKnown.copy(squad.lastKnown);
    bot.infoTime = squad.contactTime;
    bot.awareness.alert();
  }
}

function nearestEnemy(bot: Bot, env: BotEnv): Bot['target'] {
  let best: Bot['target'] = null;
  let bestDistance = Infinity;
  for (const enemy of env.enemies) {
    if (!enemy.alive) continue;
    const distance = enemy.position.distanceToSquared(bot.position);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = enemy;
    }
  }
  return best;
}

/** Take `position`, blurred by `error` metres, as the enemy's last known position. */
function learn(bot: Bot, env: BotEnv, position: Vector3, error: number): void {
  const angle = env.random() * Math.PI * 2;
  const radius = env.random() * error;
  bot.lastKnown.set(position.x + Math.cos(angle) * radius, position.y, position.z + Math.sin(angle) * radius);
  bot.infoTime = env.time;
  bot.awareness.alert();
}

// ---------------------------------------------------------------- calm states

/** Patrol near the post, or go and look at a noise. */
function roam(bot: Bot, env: BotEnv, dt: number): void {
  bot.fireMode = 'none';
  bot.crouching = false;
  if (bot.investigatePending) {
    bot.investigatePending = false;
    bot.setState('investigate', `heard ${bot.noiseKind}`);
    bot.watch = 'point';
    bot.watchPoint.copy(bot.noisePoint);
    bot.watchPoint.y += BODY.chestStand;
    bot.moveTo(bot.noisePoint.x, bot.noisePoint.y, bot.noisePoint.z, SPEED.jog);
    bot.idleTimer = INVESTIGATE_SECONDS + env.random() * 3;
    return;
  }
  if (bot.moving) return;
  bot.watch = 'none';
  lookAround(bot, env, dt);
  bot.idleTimer -= dt;
  if (bot.idleTimer > 0) return;
  if (bot.state === 'investigate') {
    bot.setState('patrol', 'nothing found');
    return;
  }
  const bias = env.sweepBias(bot) * (bot.roleDef.holds ? 0.6 : 1);
  const lead = env.enemies[0]?.position ?? bot.home;
  const angle = env.random() * Math.PI * 2;
  const radius = PATROL_RADIUS_MIN + env.random() * PATROL_RADIUS_SPREAD;
  const x = bot.home.x + (lead.x - bot.home.x) * bias + Math.cos(angle) * radius;
  const y = bot.home.y + (lead.y - bot.home.y) * bias;
  const z = bot.home.z + (lead.z - bot.home.z) * bias + Math.sin(angle) * radius;
  const node = env.grid.nearestNode(x, y, z, 4);
  // Nobody patrols into the water; another spot is picked at the next decision.
  if (node < 0 || env.grid.wet[node]) return;
  // A relaxed walk round the post; a brisker search once the squad starts sweeping.
  const sweeping = bias > SWEEP_JOG_BIAS;
  bot.moveTo(env.grid.nodeX(node), env.grid.nodeY[node] ?? y, env.grid.nodeZ(node), sweeping ? SPEED.jog : SPEED.walk);
  bot.idleTimer = (sweeping ? 0.5 : bot.roleDef.holds ? 5 : 2) + env.random() * (sweeping ? 1.5 : 4);
}
