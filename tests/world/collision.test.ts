import { BoxGeometry, Matrix4, PlaneGeometry, Vector3 } from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { CollisionWorld } from '../../src/world/collision';

const world = new CollisionWorld();

beforeAll(() => {
  const ground = new PlaneGeometry(100, 100);
  ground.rotateX(-Math.PI / 2);
  world.addCollider(ground, new Matrix4(), 'dirt');
  // A 2 m metal wall across the path at z = -5.
  world.addCollider(new BoxGeometry(10, 2, 0.4), new Matrix4().makeTranslation(0, 1, -5), 'metal');
  // A 0.15 m step at x = 20.
  world.addCollider(new BoxGeometry(2, 0.15, 2), new Matrix4().makeTranslation(20, 0.075, 0), 'wood');
  world.build();
});

function settle(position: Vector3, velocity: Vector3, seconds: number) {
  let pos = position;
  let vel = velocity;
  let result = world.moveCapsule(pos, vel, 0, 0.34, 1.8);
  for (let t = 0; t < seconds; t += 1 / 60) {
    vel = vel.clone();
    vel.y -= 17.5 / 60;
    result = world.moveCapsule(pos, vel, 1 / 60, 0.34, 1.8);
    pos = result.position;
    vel = result.velocity;
    if (result.onGround && vel.y < 0) vel.y = 0;
  }
  return result;
}

describe('CollisionWorld', () => {
  it('raycasts to the nearest surface and reports its kind', () => {
    const hit = world.raycast(new Vector3(0, 1, 0), new Vector3(0, 0, -1), 50);
    expect(hit?.surface).toBe('metal');
    expect(hit?.distance).toBeCloseTo(4.8, 3);
    expect(hit?.normal.z).toBeCloseTo(1, 3);
    expect(world.raycast(new Vector3(0, 1, 0), new Vector3(0, -1, 0), 50)?.surface).toBe('dirt');
    expect(world.raycast(new Vector3(0, 1, 0), new Vector3(0, 1, 0), 50)).toBeNull();
  });

  it('answers line of sight', () => {
    expect(world.lineOfSight(new Vector3(0, 1, 0), new Vector3(0, 1, -10))).toBe(false);
    expect(world.lineOfSight(new Vector3(0, 3, 0), new Vector3(0, 3, -10))).toBe(true);
  });

  it('drops a capsule onto the ground and reports the surface', () => {
    const result = settle(new Vector3(5, 2, 5), new Vector3(), 1.5);
    expect(result.onGround).toBe(true);
    expect(result.position.y).toBeCloseTo(0, 1);
    expect(result.groundSurface).toBe('dirt');
  });

  it('stops a walking capsule at a wall', () => {
    const result = settle(new Vector3(0, 0.02, 0), new Vector3(0, 0, -4), 3);
    expect(result.position.z).toBeGreaterThan(-4.8 + 0.3);
    expect(result.position.z).toBeLessThan(-4);
  });

  it('walks up a low step', () => {
    let pos = new Vector3(17.5, 0.02, 0);
    let vel = new Vector3(3, 0, 0);
    for (let i = 0; i < 60; i++) {
      vel = new Vector3(3, vel.y - 17.5 / 60, 0);
      const result = world.moveCapsule(pos, vel, 1 / 60, 0.34, 1.8);
      pos = result.position;
      vel = result.velocity;
      if (result.onGround && vel.y < 0) vel.y = 0;
    }
    expect(pos.x).toBeGreaterThan(19.5);
    expect(pos.y).toBeGreaterThan(0.1);
  });

  it('finds ground height', () => {
    expect(world.groundHeight(20, 0, 5)).toBeCloseTo(0.15, 3);
    expect(world.groundHeight(500, 0, 5)).toBeNull();
  });
});
