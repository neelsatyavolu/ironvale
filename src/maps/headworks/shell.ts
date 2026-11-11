import * as THREE from 'three/webgpu';
import { rampGeometry } from './colliders';
import { V, type Kit } from './kit';
import type { Materials } from './materials';
import { BLOCKS, HALF_X, HALF_Z, isTwin, RAILS, RAMPS, type Block, type BlockRole } from './plan';

const BEVEL = 0.05;
/** Slightly different casts, so neighbouring structures do not read as one pour. */
const TONE = { fresh: 0xffffff, warm: 0xf4efe6, grey: 0xe6e8ea, old: 0xdcd8d0, dark: 0xc9c9c6 } as const;

const CAST_ROLES: readonly BlockRole[] = ['perimeter', 'building', 'wall', 'basin', 'gallery', 'house', 'roof', 'deck', 'parapet'];

const toneOf = (b: Block): number => {
  if (b.role === 'perimeter') return TONE.old;
  if (b.role === 'building' || b.role === 'gallery') return isTwin(b) ? TONE.grey : TONE.warm;
  if (b.role === 'basin') return TONE.dark;
  if (b.role === 'house' || b.role === 'roof') return isTwin(b) ? TONE.warm : TONE.fresh;
  return isTwin(b) ? TONE.fresh : TONE.grey;
};

/** Coping: a cap a little wider than the wall, with a drip overhang. */
function coping(kit: Kit, m: Materials, b: Block, color: number): void {
  const top = b.y + b.h;
  kit.slab(m.concrete, b.x0 - 0.07, b.x1 + 0.07, top, top + 0.12, b.z0 - 0.07, b.z1 + 0.07, 0.03, color);
}

/** Shallow piers on the inside of a long wall, one every few metres, the way a tall retaining wall is stiffened. */
function piers(kit: Kit, m: Materials, b: Block, color: number): void {
  const alongX = b.x1 - b.x0 > b.z1 - b.z0;
  const length = alongX ? b.x1 - b.x0 : b.z1 - b.z0;
  const count = Math.round(length / 7.2);
  for (let i = 1; i < count; i++) {
    const t = (alongX ? b.x0 : b.z0) + (length * i) / count;
    // The pier stands on the side of the wall that faces the middle of the map.
    if (alongX) {
      const inner = b.z0 < 0 ? b.z1 : b.z0;
      const out = b.z0 < 0 ? 1 : -1;
      kit.slab(m.concrete, t - 0.3, t + 0.3, 0, b.h - 0.1, Math.min(inner, inner + out * 0.14), Math.max(inner, inner + out * 0.14), 0.04, color);
    } else {
      const inner = b.x0 < 0 ? b.x1 : b.x0;
      const out = b.x0 < 0 ? 1 : -1;
      kit.slab(m.concrete, Math.min(inner, inner + out * 0.14), Math.max(inner, inner + out * 0.14), 0, b.h - 0.1, t - 0.3, t + 0.3, 0.04, color);
    }
  }
}

/** Everything cast in place: walls, buildings, basins, decks and roofs, each a chamfered pour. */
export function buildCastWork(kit: Kit, m: Materials): void {
  for (const b of BLOCKS) {
    if (!CAST_ROLES.includes(b.role)) continue;
    const color = toneOf(b);
    const bevel = b.role === 'deck' || b.role === 'building' ? 0.07 : BEVEL;
    kit.slab(m.concrete, b.x0, b.x1, b.y, b.y + b.h, b.z0, b.z1, bevel, color);
    const freeWall = (b.role === 'wall' || b.role === 'perimeter') && !b.id.includes('lintel');
    if (freeWall) coping(kit, m, b, color);
    if (b.role === 'perimeter') piers(kit, m, b, color);
    if (b.role === 'parapet') coping(kit, m, b, color);
  }
}

/** The four ramps, cast solid, with a raised kerb on the open side. */
export function buildRamps(kit: Kit, m: Materials): void {
  const identity = new THREE.Matrix4();
  for (const ramp of RAMPS) {
    const geometry = rampGeometry(ramp);
    kit.add(m.concrete, geometry, identity, isTwin(ramp) ? TONE.fresh : TONE.grey);
    geometry.dispose();
  }
  for (const rail of RAILS) {
    const a = V(rail.ax, rail.ay + 0.07, rail.az);
    const b = V(rail.bx, rail.by + 0.07, rail.bz);
    kit.beam(m.concrete, a, b, 0.16, 0.14, TONE.old);
  }
}

/** Ground: the pale yard slab, the dark service roads laid over it and the land outside the wall. */
export function buildGround(kit: Kit, m: Materials): void {
  const plane = (material: THREE.Material, x0: number, x1: number, z0: number, z1: number, y: number, color?: number): void => {
    const geometry = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
    geometry.rotateX(-Math.PI / 2);
    kit.add(material, geometry, new THREE.Matrix4().makeTranslation((x0 + x1) / 2, y, (z0 + z1) / 2), color);
    geometry.dispose();
  };
  plane(m.paving, -HALF_X - 1, HALF_X + 1, -HALF_Z - 1, HALF_Z + 1, 0);
  // Filter Walk on the north side and its twin on the south: a wearing course a finger thick over the slab.
  for (const s of [1, -1]) {
    const road = { x0: -HALF_X, x1: -5, z0: -35, z1: -23.4 };
    const [x0, x1] = s > 0 ? [road.x0, road.x1] : [-road.x1, -road.x0];
    const [z0, z1] = s > 0 ? [road.z0, road.z1] : [-road.z1, -road.z0];
    plane(m.road, x0, x1, z0, z1, 0.012);
    // Flush concrete kerb strip along the open edge.
    plane(m.paving, x0, x1, s > 0 ? z1 : z0 - 0.3, s > 0 ? z1 + 0.3 : z0, 0.014, 0xd8d8d2);
  }
}
