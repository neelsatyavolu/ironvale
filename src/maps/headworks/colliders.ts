import * as THREE from 'three/webgpu';
import type { Surface, World } from '../../world/types';
import { BLOCKS, BRIDGE, DRUMS, RAILS, RAMPS, type Block, type BlockRole, type Rail, type Ramp } from './plan';

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const DRUM_SEGMENTS = 32;
const RAIL_HEIGHT = 1.1;
const RAIL_THICKNESS = 0.08;

const METAL_ROLES: readonly BlockRole[] = ['kiosk', 'cabinet', 'pumpset', 'manifold', 'pipes'];

export const surfaceOf = (role: BlockRole): Surface => (METAL_ROLES.includes(role) ? 'metal' : 'concrete');

export function blockMatrix(b: Block): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3((b.x0 + b.x1) / 2, b.y + b.h / 2, (b.z0 + b.z1) / 2),
    new THREE.Quaternion(),
    new THREE.Vector3(b.x1 - b.x0, b.h, b.z1 - b.z0),
  );
}

/**
 * Solid wedge under a ramp: a triangular prism from the foot (on the ground)
 * to the top edge, `width` across. Used for both the collider and the visible
 * ramp so nobody can stand underneath it.
 */
export function rampGeometry(ramp: Ramp): THREE.BufferGeometry {
  const run = new THREE.Vector3(ramp.topX - ramp.footX, 0, ramp.topZ - ramp.footZ);
  const side = new THREE.Vector3(-run.z, 0, run.x).normalize().multiplyScalar(ramp.width / 2);
  const foot = new THREE.Vector3(ramp.footX, 0, ramp.footZ);
  const top = new THREE.Vector3(ramp.topX, ramp.rise, ramp.topZ);
  const base = new THREE.Vector3(ramp.topX, 0, ramp.topZ);
  const corner = (p: THREE.Vector3, sign: number): THREE.Vector3 => p.clone().addScaledVector(side, sign);
  const [f0, f1, t0, t1, b0, b1] = [corner(foot, -1), corner(foot, 1), corner(top, -1), corner(top, 1), corner(base, -1), corner(base, 1)];
  // Slope, back, underside and the two triangular flanks. Wound so every face points outward.
  const quads: THREE.Vector3[][] = [
    [f1, t1, t0, f0],
    [t1, b1, b0, t0],
    [f0, b0, b1, f1],
  ];
  const triangles: THREE.Vector3[][] = [
    [f0, t0, b0],
    [f1, b1, t1],
  ];
  for (const [a, b, c, d] of quads as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3][]) triangles.push([a, b, c], [a, c, d]);
  const positions: number[] = [];
  const uvs: number[] = [];
  for (const triangle of triangles) {
    for (const p of triangle) {
      positions.push(p.x, p.y, p.z);
      uvs.push(0, 0);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}

/** Thin upright slab along a rail line, for stopping bodies at a drop. */
function railMatrix(rail: Rail): THREE.Matrix4 {
  const a = new THREE.Vector3(rail.ax, rail.ay + RAIL_HEIGHT / 2, rail.az);
  const b = new THREE.Vector3(rail.bx, rail.by + RAIL_HEIGHT / 2, rail.bz);
  const along = new THREE.Vector3().subVectors(b, a);
  const length = along.length();
  along.normalize();
  const side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), along).normalize();
  const up = new THREE.Vector3().crossVectors(along, side);
  return new THREE.Matrix4()
    .makeBasis(along, up, side)
    .scale(new THREE.Vector3(length, RAIL_HEIGHT, RAIL_THICKNESS))
    .setPosition(a.add(b).multiplyScalar(0.5));
}

/**
 * Everything solid in the level, straight from the plan. The visible level is
 * drawn over the same shapes; the handrails only stop bodies, so shots pass
 * between the bars.
 */
export function registerColliders(world: World): void {
  const ground = new THREE.Matrix4().compose(new THREE.Vector3(0, -0.5, 0), new THREE.Quaternion(), new THREE.Vector3(140, 1, 130));
  world.addCollider(UNIT_BOX, ground, 'concrete');
  for (const b of BLOCKS) world.addCollider(UNIT_BOX, blockMatrix(b), surfaceOf(b.role));
  for (const d of DRUMS) {
    const geometry = new THREE.CylinderGeometry(d.r, d.r, d.h, DRUM_SEGMENTS);
    world.addCollider(geometry, new THREE.Matrix4().makeTranslation(d.x, d.h / 2, d.z), d.role === 'silo' ? 'metal' : 'concrete');
    geometry.dispose();
  }
  const identity = new THREE.Matrix4();
  for (const ramp of RAMPS) {
    const geometry = rampGeometry(ramp);
    world.addCollider(geometry, identity, 'concrete');
    geometry.dispose();
  }
  const bridge = new THREE.Matrix4().compose(
    new THREE.Vector3(0, BRIDGE.underside + BRIDGE.depth / 2, 0),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), BRIDGE.yaw),
    new THREE.Vector3(BRIDGE.length, BRIDGE.depth, BRIDGE.width),
  );
  world.addCollider(UNIT_BOX, bridge, 'concrete');
  for (const rail of RAILS) world.addBoundary(UNIT_BOX, railMatrix(rail));
}
