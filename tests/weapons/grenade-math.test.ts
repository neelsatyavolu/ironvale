import { BoxGeometry, Matrix4, PlaneGeometry, Vector3 } from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  GRENADE,
  blastDamage,
  blastDamageAt,
  blastShake,
  createGrenadeBody,
  predictArc,
  stepGrenade,
  throwVelocity,
  type GrenadeBody,
} from '../../src/weapons/grenade-math';
import { CollisionWorld } from '../../src/world/collision';

const world = new CollisionWorld();
const STEP = GRENADE.step;

beforeAll(() => {
  const ground = new PlaneGeometry(200, 200);
  ground.rotateX(-Math.PI / 2);
  world.addCollider(ground, new Matrix4(), 'concrete');
  // A 3 m wall across the range at z = -5, from x = -5 to x = 5.
  world.addCollider(new BoxGeometry(10, 3, 0.4), new Matrix4().makeTranslation(0, 1.5, -5), 'metal');
  world.build();
});

function launch(origin: Vector3, velocity: Vector3): GrenadeBody {
  const body = createGrenadeBody();
  body.position.copy(origin);
  body.velocity.copy(velocity);
  return body;
}

/** Step until rest or the fuse runs out; returns the first impact point (or null) and the lowest height seen. */
function run(body: GrenadeBody, seconds: number = GRENADE.fuse) {
  let first: Vector3 | null = null;
  let lowest = Infinity;
  let bounces = 0;
  for (let t = 0; t < seconds && !body.resting; t += STEP) {
    stepGrenade(body, world, STEP);
    if (body.impact > 0) {
      bounces++;
      first ??= body.position.clone();
    }
    lowest = Math.min(lowest, body.position.y);
  }
  return { first, lowest, bounces };
}

describe('throwVelocity', () => {
  it('throws at the set speed with a slight upward bias', () => {
    const velocity = throwVelocity(new Vector3(0, 0, -1), new Vector3());
    expect(velocity.length()).toBeCloseTo(GRENADE.throwSpeed, 5);
    const angle = Math.atan2(velocity.y, -velocity.z) * (180 / Math.PI);
    expect(angle).toBeGreaterThan(6);
    expect(angle).toBeLessThan(15);
    expect(velocity.x).toBeCloseTo(0, 6);
  });

  it('follows the look direction', () => {
    const up = throwVelocity(new Vector3(0, 0.7071, -0.7071), new Vector3());
    const level = throwVelocity(new Vector3(0, 0, -1), new Vector3());
    expect(up.y).toBeGreaterThan(level.y + 5);
    const side = throwVelocity(new Vector3(1, 0, 0), new Vector3());
    expect(side.x).toBeGreaterThan(15);
  });
});

describe('stepGrenade', () => {
  it('follows a ballistic path in free flight', () => {
    const origin = new Vector3(40, 30, 40);
    const velocity = new Vector3(6, 4, -3);
    const body = launch(origin, velocity);
    const seconds = 1;
    for (let i = 0; i < Math.round(seconds / STEP); i++) stepGrenade(body, world, STEP);
    expect(body.position.x).toBeCloseTo(origin.x + velocity.x * seconds, 3);
    expect(body.position.z).toBeCloseTo(origin.z + velocity.z * seconds, 3);
    const y = origin.y + velocity.y * seconds - 0.5 * GRENADE.gravity * seconds * seconds;
    expect(Math.abs(body.position.y - y)).toBeLessThan(0.12);
    expect(body.impact).toBe(0);
  });

  it('lands a level throw about 15 m out and comes to rest before the fuse ends', () => {
    // Thrown along +X, clear of the wall.
    const body = launch(new Vector3(20, 1.45, 40), throwVelocity(new Vector3(1, 0, 0), new Vector3()));
    const { first, lowest, bounces } = run(body);
    expect(first).not.toBeNull();
    const landed = first!.x - 20;
    expect(landed).toBeGreaterThan(13);
    expect(landed).toBeLessThan(18);
    expect(bounces).toBeGreaterThanOrEqual(2);
    expect(body.resting).toBe(true);
    const rest = body.position.x - 20;
    expect(rest).toBeGreaterThan(landed);
    expect(rest).toBeLessThan(22);
    // Never through the floor, and it ends up sitting on it.
    expect(lowest).toBeGreaterThan(0);
    expect(body.position.y).toBeCloseTo(GRENADE.radius, 1);
  });

  it('loses height on each bounce', () => {
    const body = launch(new Vector3(40, 2, 40), new Vector3());
    let peak = 0;
    let bounced = false;
    for (let t = 0; t < 1.5; t += STEP) {
      stepGrenade(body, world, STEP);
      if (body.impact > 0 && !bounced) {
        bounced = true;
        expect(body.surface).toBe('concrete');
        expect(body.impact).toBeGreaterThan(5);
      } else if (bounced && body.impact > 0) break;
      if (bounced) peak = Math.max(peak, body.position.y);
    }
    expect(bounced).toBe(true);
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThan(0.7);
  });

  it('bounces back off a wall', () => {
    const body = launch(new Vector3(0, 1.5, 0), new Vector3(0, 2, -14));
    let hitWall = false;
    for (let t = 0; t < GRENADE.fuse && !body.resting; t += STEP) {
      stepGrenade(body, world, STEP);
      if (body.impact > 0 && body.surface === 'metal') {
        hitWall = true;
        expect(body.velocity.z).toBeGreaterThan(0);
      }
      // The near face of the wall is at z = -4.8.
      expect(body.position.z).toBeGreaterThan(-4.8);
    }
    expect(hitWall).toBe(true);
  });

  it('does nothing once at rest', () => {
    const body = launch(new Vector3(40, GRENADE.radius, 40), new Vector3());
    body.resting = true;
    stepGrenade(body, world, STEP);
    expect(body.position.y).toBe(GRENADE.radius);
  });
});

describe('predictArc', () => {
  it('ends where the thrown grenade ends', () => {
    const origin = new Vector3(0, 1.45, 3);
    const velocity = throwVelocity(new Vector3(0.2, 0.1, -1).normalize(), new Vector3());
    const points = new Float32Array(GRENADE.maxArcPoints * 3);
    const count = predictArc(origin, velocity, world, points);
    expect(count).toBeGreaterThan(10);
    expect(count).toBeLessThanOrEqual(GRENADE.maxArcPoints);

    const body = launch(origin, velocity);
    run(body);
    const last = (count - 1) * 3;
    expect(points[last]).toBeCloseTo(body.position.x, 5);
    expect(points[last + 1]).toBeCloseTo(body.position.y, 5);
    expect(points[last + 2]).toBeCloseTo(body.position.z, 5);
    expect(points[0]).toBe(origin.x);
    // The inputs are left alone.
    expect(origin.z).toBe(3);
  });
});

describe('blast', () => {
  it('is lethal close in and harmless far out', () => {
    expect(blastDamage(0)).toBeGreaterThanOrEqual(100);
    expect(blastDamage(GRENADE.lethalRadius)).toBeGreaterThanOrEqual(100);
    expect(blastDamage(GRENADE.lethalRadius + 0.5)).toBeLessThan(100);
    expect(blastDamage(GRENADE.blastRadius)).toBe(0);
    expect(blastDamage(50)).toBe(0);
  });

  it('falls off steadily with distance', () => {
    let previous = Infinity;
    for (let d = 0; d <= 9; d += 0.25) {
      const damage = blastDamage(d);
      expect(damage).toBeLessThanOrEqual(previous);
      previous = damage;
    }
    expect(blastDamage(5.5)).toBeGreaterThan(20);
    expect(blastDamage(5.5)).toBeLessThan(80);
  });

  it('is stopped by a wall', () => {
    const blast = new Vector3(0, 0.1, -4);
    // 2 m away in the open.
    expect(blastDamageAt(blast, new Vector3(2, 1.2, -4), world)).toBeGreaterThanOrEqual(100);
    // 2 m away behind the wall.
    expect(blastDamageAt(blast, new Vector3(0, 1.2, -6), world)).toBe(0);
    // Past the end of the wall there is a clear line again.
    expect(blastDamageAt(new Vector3(7, 0.1, -4), new Vector3(7, 1.2, -6.5), world)).toBeGreaterThan(0);
    // Out of range in the open.
    expect(blastDamageAt(blast, new Vector3(0, 1.2, 6), world)).toBe(0);
  });

  it('shakes the view less with distance', () => {
    expect(blastShake(2)).toBeGreaterThan(blastShake(10));
    expect(blastShake(10)).toBeGreaterThan(0);
    expect(blastShake(GRENADE.shakeRadius)).toBe(0);
    expect(blastShake(0)).toBeLessThanOrEqual(1);
  });
});
