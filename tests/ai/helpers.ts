import { Box3, BoxGeometry, BufferAttribute, BufferGeometry, Matrix4, PlaneGeometry, Vector3 } from 'three/webgpu';
import { buildNavGrid, type NavGrid } from '../../src/ai/navgrid';
import { CollisionWorld } from '../../src/world/collision';

/**
 * Synthetic level, 40 x 40 m around the origin:
 * - flat floor at y = 0
 * - a 2.5 m wall from x = -5 to 5 at z = -5 (0.4 m thick)
 * - a 1.3 m low wall from x = -5 to 5 at z = 10
 * - a ramp rising 3 m from x = 0 to x = 9 (z -1.5 .. 1.5)
 * - a platform with its top at y = 3 over x 9 .. 15, z -3 .. 3 (walkable below)
 * - a 0.5 m crate at (-12, 0) nobody can step onto, and a 0.15 m slab at (-12, 8)
 */
export function buildTestWorld(): CollisionWorld {
  const world = new CollisionWorld();
  const floor = new PlaneGeometry(40, 40);
  floor.rotateX(-Math.PI / 2);
  world.addCollider(floor, new Matrix4(), 'concrete');
  world.addCollider(new BoxGeometry(10, 2.5, 0.4), new Matrix4().makeTranslation(0, 1.25, -5), 'concrete');
  world.addCollider(new BoxGeometry(10, 1.3, 0.4), new Matrix4().makeTranslation(0, 0.65, 10), 'concrete');

  const ramp = new BufferGeometry();
  ramp.setAttribute(
    'position',
    new BufferAttribute(
      new Float32Array([0, 0, -1.5, 9, 3, 1.5, 9, 3, -1.5, 0, 0, -1.5, 0, 0, 1.5, 9, 3, 1.5]),
      3,
    ),
  );
  world.addCollider(ramp, new Matrix4(), 'metal');
  world.addCollider(new BoxGeometry(6, 0.3, 6), new Matrix4().makeTranslation(12, 2.85, 0), 'metal');

  world.addCollider(new BoxGeometry(2.4, 0.5, 2.4), new Matrix4().makeTranslation(-12, 0.25, 0), 'wood');
  world.addCollider(new BoxGeometry(2.4, 0.15, 2.4), new Matrix4().makeTranslation(-12, 0.075, 8), 'wood');
  world.build();
  return world;
}

export const TEST_BOUNDS = new Box3(new Vector3(-18, -1, -18), new Vector3(18, 8, 18));

export function buildTestGrid(world: CollisionWorld, seeds: readonly Vector3[] = [new Vector3(0, 0, 5)]): NavGrid {
  const builder = buildNavGrid(world, TEST_BOUNDS, seeds);
  let step = builder.next();
  while (!step.done) step = builder.next();
  return step.value;
}
