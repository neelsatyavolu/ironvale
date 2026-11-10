import { Vector3 } from 'three/webgpu';
import type { Ballistics, Combatant, GameContext, ShotResult, WeaponDef } from '../game/contracts';
import { closestPointOnSegment, damageAt, sampleCone } from './math';

/** Bullets that travel further than this land after their flight time instead of at once. */
const INSTANT_RANGE = 80;
const NEAR_MISS_RADIUS = 1.2;
/** Other shooters have no view model, so their brass appears a little behind the muzzle. */
const CASING_BEHIND_MUZZLE = 0.45;
const CASING_SIDE_SPEED = 2.2;
const CASING_UP_SPEED = 1.5;
/** Seconds after the shot at which a bot's bolt or pump throws the case. */
const BOLT_EJECT_DELAY = 0.6;
const PUMP_EJECT_DELAY = 0.3;

interface Pending {
  readonly due: number;
  readonly kind: 'land' | 'casing' | 'whiz';
  readonly weapon: WeaponDef;
  readonly shooterId: number;
  readonly result: ShotResult | null;
  readonly direction: Vector3;
  readonly point: Vector3;
}

const UP = new Vector3(0, 1, 0);

/**
 * Shared hitscan ballistics. One call is one trigger pull: every pellet gets
 * its own cone sample, trace and damage. See `Ballistics` in the contracts.
 *
 * The local player's rounds are traced from the camera so they land under the
 * reticle; everyone else's are traced from the muzzle they pass in. Casings
 * for the local player come from the view model, so none are emitted here.
 */
export function createBallisticsSystem(ctx: GameContext, random: () => number = Math.random): Ballistics {
  const pending: Pending[] = [];
  const aim = new Vector3();
  const pellet = new Vector3();
  const head = new Vector3();
  const nearest = new Vector3();
  const side = new Vector3();
  const casingPosition = new Vector3();
  const casingVelocity = new Vector3();
  let lastTime = ctx.time;

  function land(weapon: WeaponDef, shooterId: number, result: ShotResult, direction: Vector3): void {
    const target = result.combatant;
    const hit = result.combatantHit;
    if (target && hit) {
      if (!target.alive) return;
      target.applyDamage({
        amount: damageAt(weapon, hit.distance, hit.zone),
        zone: hit.zone,
        attackerId: shooterId,
        weaponId: weapon.id,
        point: hit.point,
        direction,
      });
      ctx.events.emit('combatantHit', {
        weapon,
        targetId: target.id,
        attackerId: shooterId,
        hit,
        direction,
        fatal: !target.alive,
      });
    } else if (result.world) {
      ctx.events.emit('bulletImpact', { shooterId, weapon, hit: result.world });
    }
  }

  function ejectCasing(weapon: WeaponDef, shooter: Combatant | undefined, muzzle: Vector3, direction: Vector3): void {
    side.crossVectors(direction, UP);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    casingPosition.copy(muzzle).addScaledVector(direction, -CASING_BEHIND_MUZZLE);
    casingVelocity
      .copy(side)
      .multiplyScalar(CASING_SIDE_SPEED * (0.8 + random() * 0.4))
      .addScaledVector(UP, CASING_UP_SPEED * (0.7 + random() * 0.6));
    if (shooter) casingVelocity.add(shooter.velocity);
    ctx.events.emit('casingEjected', { kind: weapon.casing, position: casingPosition, velocity: casingVelocity });
  }

  function later(seconds: number, entry: Omit<Pending, 'due'>): void {
    pending.push({ ...entry, due: ctx.time + seconds });
  }

  function flush(): void {
    const now = ctx.time;
    // The clock going backwards means a new match: nothing in flight carries over.
    if (now < lastTime) pending.length = 0;
    lastTime = now;
    for (let i = pending.length - 1; i >= 0; i--) {
      const entry = pending[i]!;
      if (entry.due > now) continue;
      pending[i] = pending[pending.length - 1]!;
      pending.pop();
      if (entry.kind === 'land' && entry.result) land(entry.weapon, entry.shooterId, entry.result, entry.direction);
      else if (entry.kind === 'whiz') {
        ctx.events.emit('nearMiss', { point: entry.point, direction: entry.direction, weapon: entry.weapon });
      }
      else if (entry.kind === 'casing') {
        ejectCasing(entry.weapon, ctx.combat.get(entry.shooterId), entry.point, entry.direction);
      }
    }
  }

  /** Returns true when a near miss was reported for this round. */
  function checkNearMiss(weapon: WeaponDef, origin: Vector3, result: ShotResult, direction: Vector3): boolean {
    const player = ctx.player;
    if (!player.alive || result.combatant === player) return false;
    player.eyePosition(head);
    closestPointOnSegment(origin, result.end, head, nearest);
    if (nearest.distanceToSquared(head) > NEAR_MISS_RADIUS * NEAR_MISS_RADIUS) return false;
    const along = nearest.distanceTo(origin);
    if (along > INSTANT_RANGE) {
      later(along / weapon.muzzleVelocity, {
        kind: 'whiz',
        weapon,
        shooterId: -1,
        result: null,
        direction: direction.clone(),
        point: nearest.clone(),
      });
    } else {
      ctx.events.emit('nearMiss', { point: nearest, direction, weapon });
    }
    return true;
  }

  ctx.engine.onFrame(flush);

  return {
    fire(shooter, weapon, muzzle, direction, spreadDegrees) {
      const local = shooter.kind === 'local';
      aim.copy(direction).normalize();
      ctx.events.emit('shotFired', { shooterId: shooter.id, weapon, muzzle, direction: aim, local });

      const origin = local ? ctx.engine.camera.position : muzzle;
      const spread = spreadDegrees ?? weapon.spreadHip;
      let whizzed = local;
      for (let i = 0; i < weapon.pellets; i++) {
        sampleCone(aim, spread, random, pellet);
        // Bullets pass through the shooter's own side: no friendly fire.
        const result = ctx.combat.raycast(origin, pellet, weapon.range, shooter.id, shooter.team);
        ctx.events.emit('bulletTrace', { shooterId: shooter.id, weapon, from: muzzle, to: result.end, local });
        if (!whizzed) whizzed = checkNearMiss(weapon, origin, result, pellet);
        if (result.distance > INSTANT_RANGE) {
          later(result.distance / weapon.muzzleVelocity, {
            kind: 'land',
            weapon,
            shooterId: shooter.id,
            result,
            direction: pellet.clone(),
            point: result.end,
          });
        } else {
          land(weapon, shooter.id, result, pellet);
        }
      }

      if (local) return;
      if (weapon.fireMode === 'bolt' || weapon.fireMode === 'pump') {
        later(weapon.fireMode === 'bolt' ? BOLT_EJECT_DELAY : PUMP_EJECT_DELAY, {
          kind: 'casing',
          weapon,
          shooterId: shooter.id,
          result: null,
          direction: aim.clone(),
          point: muzzle.clone(),
        });
      } else {
        ejectCasing(weapon, shooter, muzzle, aim);
      }
    },
  };
}
