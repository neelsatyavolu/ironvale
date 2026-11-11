import { Vector3 } from 'three/webgpu';
import type { Combatant, GameContext, GrenadeFlight, Grenades, Team, WeaponDef } from '../game/contracts';
import { GRENADE, blastDamageAt, createGrenadeBody, stepGrenade, type GrenadeBody } from './grenade-math';

export const GRENADE_ID = 'grenade';

/**
 * The grenade as a weapon, for everything that names what did the damage
 * (hit events, the kill feed, the two-player damage cap). It is not in the
 * loadout and is never fired through `Ballistics`.
 */
export const GRENADE_DEF: WeaponDef = {
  id: GRENADE_ID,
  name: 'Grenade',
  weaponClass: 'pistol',
  slot: 0,
  fireMode: 'semi',
  roundsPerMinute: 30,
  damage: GRENADE.maxDamage,
  headshotMultiplier: 1,
  limbMultiplier: 1,
  falloffStart: GRENADE.lethalRadius,
  falloffEnd: GRENADE.blastRadius,
  falloffMin: 0,
  range: GRENADE.blastRadius,
  muzzleVelocity: GRENADE.throwSpeed,
  pellets: 1,
  spreadHip: 0,
  spreadAim: 0,
  spreadMoving: 0,
  recoil: { vertical: 0, horizontal: 0, recovery: 1, kickback: 0 },
  magazineSize: 1,
  reserveAmmo: 0,
  reloadStyle: 'magazine',
  reloadTime: 0,
  aimTime: 0,
  aimZoom: 1,
  scoped: false,
  mobility: 1,
  casing: 'pistol',
  loudness: 1,
};

/** Both players' grenades in the air at once, with room to spare. */
const POOL_SIZE = 4;
/** Steps run in one frame at most, so a stalled tab does not replay seconds of flight at once. */
const MAX_STEPS_PER_FRAME = 8;
/** Bounces closer together than this are one sound. */
const BOUNCE_GAP_SECONDS = 0.09;
/** A shown grenade whose blast never arrives from the other machine goes off by itself this long after its fuse. */
const DETONATE_GRACE_SECONDS = 1.5;
/** The other machine may place its blast this far from where the grenade is shown here. */
const DETONATE_TOLERANCE = 6;
/** Chest height as a share of eye height. */
const CHEST_SHARE = 0.75;

interface Flight extends GrenadeFlight {
  active: boolean;
  ownerId: number;
  team: Team;
  authoritative: boolean;
  fuse: number;
  sinceBounce: number;
  readonly body: GrenadeBody;
  readonly previous: Vector3;
}

function createFlight(): Flight {
  const body = createGrenadeBody();
  return {
    active: false,
    ownerId: -1,
    team: 'alpha',
    authoritative: false,
    fuse: 0,
    sinceBounce: 0,
    body,
    previous: new Vector3(),
    drawPosition: new Vector3(),
    velocity: body.velocity,
    get resting() {
      return body.resting;
    },
  };
}

/** Flies thrown grenades through the collision world and, for the ones this machine owns, applies the blast. */
class GrenadeSystem implements Grenades {
  readonly flights: Flight[] = Array.from({ length: POOL_SIZE }, createFlight);
  private accumulator = 0;
  private readonly eye = new Vector3();
  private readonly chest = new Vector3();
  private readonly direction = new Vector3();
  private readonly blast = new Vector3();

  constructor(private readonly ctx: GameContext) {}

  launch(owner: Combatant, origin: Vector3, velocity: Vector3, authoritative: boolean): void {
    const flight = this.flights.find((candidate) => !candidate.active);
    if (!flight) return;
    flight.active = true;
    flight.ownerId = owner.id;
    flight.team = owner.team;
    flight.authoritative = authoritative;
    flight.fuse = GRENADE.fuse;
    flight.sinceBounce = BOUNCE_GAP_SECONDS;
    flight.body.position.copy(origin);
    flight.body.velocity.copy(velocity);
    flight.body.resting = false;
    flight.body.impact = 0;
    flight.previous.copy(origin);
    flight.drawPosition.copy(origin);
    this.ctx.events.emit('grenadeThrown', {
      ownerId: owner.id,
      position: flight.body.position,
      velocity: flight.body.velocity,
      local: owner.id === this.ctx.player.id,
    });
  }

  detonate(ownerId: number, position: Vector3): void {
    for (const flight of this.flights) {
      if (!flight.active || flight.authoritative || flight.ownerId !== ownerId) continue;
      const shown = flight.body.position;
      this.explode(flight, shown.distanceTo(position) <= DETONATE_TOLERANCE ? position : shown);
      return;
    }
  }

  clear(): void {
    for (const flight of this.flights) flight.active = false;
    this.accumulator = 0;
  }

  update(dt: number): void {
    const step = GRENADE.step;
    this.accumulator = Math.min(this.accumulator + dt, step * MAX_STEPS_PER_FRAME);
    while (this.accumulator >= step) {
      this.accumulator -= step;
      for (const flight of this.flights) if (flight.active) this.step(flight, step);
    }
    const blend = this.accumulator / step;
    for (const flight of this.flights) {
      if (flight.active) flight.drawPosition.lerpVectors(flight.previous, flight.body.position, blend);
    }
  }

  private step(flight: Flight, dt: number): void {
    const body = flight.body;
    flight.previous.copy(body.position);
    stepGrenade(body, this.ctx.world, dt);
    flight.sinceBounce += dt;
    if (body.impact > 0 && flight.sinceBounce >= BOUNCE_GAP_SECONDS) {
      flight.sinceBounce = 0;
      this.ctx.events.emit('grenadeBounced', {
        ownerId: flight.ownerId,
        position: body.position,
        speed: body.impact,
        surface: body.surface,
      });
    }
    flight.fuse -= dt;
    if (flight.fuse > (flight.authoritative ? 0 : -DETONATE_GRACE_SECONDS)) return;
    this.explode(flight, body.position);
  }

  private explode(flight: Flight, position: Vector3): void {
    const { ctx } = this;
    const blast = this.blast.copy(position);
    flight.active = false;
    ctx.events.emit('grenadeExploded', {
      ownerId: flight.ownerId,
      position: blast,
      local: flight.ownerId === ctx.player.id,
    });
    if (!flight.authoritative) return;
    for (const combatant of ctx.combat.all()) {
      // It hurts whoever threw it, and the other side. Like bullets, it spares the thrower's own side.
      if (!combatant.alive || (combatant.id !== flight.ownerId && combatant.team === flight.team)) continue;
      const chest = this.chestOf(combatant);
      const amount = blastDamageAt(blast, chest, ctx.world);
      if (amount <= 0) continue;
      const direction = this.direction.subVectors(chest, blast);
      const distance = direction.length();
      if (distance > 1e-4) direction.divideScalar(distance);
      else direction.set(0, 1, 0);
      combatant.applyDamage({
        amount,
        zone: 'torso',
        attackerId: flight.ownerId,
        weaponId: GRENADE_ID,
        point: chest,
        direction,
      });
      if (combatant.id === flight.ownerId) continue;
      ctx.events.emit('combatantHit', {
        weapon: GRENADE_DEF,
        targetId: combatant.id,
        attackerId: flight.ownerId,
        hit: { distance, zone: 'torso', point: chest },
        direction,
        fatal: !combatant.alive,
      });
    }
  }

  private chestOf(combatant: Combatant): Vector3 {
    const feet = combatant.position;
    const eye = combatant.eyePosition(this.eye);
    return this.chest.set(feet.x, feet.y + (eye.y - feet.y) * CHEST_SHARE, feet.z);
  }
}

export function createGrenades(ctx: GameContext): Grenades {
  return new GrenadeSystem(ctx);
}
