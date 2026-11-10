import * as THREE from 'three/webgpu';
import type { Kit } from './facade';
import { QUAY_NORTH, STREET_NORTH, STREET_SOUTH, TERRACE_EDGE, TERRACE_NORTH, TERRACE_Y } from './layout';

interface Vine {
  readonly x: number;
  readonly z: number;
  /** Unit normal of the wall it grows on. */
  readonly nx: number;
  readonly nz: number;
  readonly base: number;
  readonly width: number;
  readonly height: number;
  /** Bougainvillea in flower rather than plain creeper. */
  readonly flowers: boolean;
  /** Spills down from `base + height` instead of climbing from the ground. */
  readonly hanging?: boolean;
}

const VINES: readonly Vine[] = [
  { x: -17.6, z: QUAY_NORTH, nx: 0, nz: 1, base: 0, width: 3.4, height: 6.6, flowers: true },
  { x: 37.9, z: QUAY_NORTH, nx: 0, nz: 1, base: 0, width: 3.0, height: 5.2, flowers: true },
  { x: -12, z: -9.4, nx: 1, nz: 0, base: 0, width: 4.2, height: 5.4, flowers: false },
  { x: 21.6, z: STREET_SOUTH, nx: 0, nz: -1, base: 0, width: 2.8, height: 5.6, flowers: true },
  { x: -47.5, z: STREET_NORTH, nx: 0, nz: 1, base: 0, width: 3.2, height: 6.2, flowers: false },
  { x: 27.4, z: TERRACE_NORTH, nx: 0, nz: 1, base: TERRACE_Y, width: 3.4, height: 6, flowers: true },
  { x: -8.6, z: TERRACE_EDGE + 0.3, nx: 0, nz: 1, base: 1.5, width: 5, height: 2.7, flowers: false, hanging: true },
  { x: 9.2, z: TERRACE_EDGE + 0.3, nx: 0, nz: 1, base: 1.9, width: 3.6, height: 2.3, flowers: true, hanging: true },
  { x: 36.5, z: 5.6, nx: -1, nz: 0, base: 0, width: 3.6, height: 5, flowers: false },
];

/** Creepers and bougainvillea on the blank stretches of wall: layers of cut-out leaf sprays a hand's width off the plaster. */
export function addGreenery(kit: Kit): void {
  const { batch, mats, random, density } = kit;
  const material = mats.spray;
  const matrix = new THREE.Matrix4();
  const turn = new THREE.Matrix4();
  const euler = new THREE.Euler();

  for (const vine of VINES) {
    const yaw = Math.atan2(vine.nx, vine.nz);
    const count = Math.round(vine.width * vine.height * 3.2 * Math.max(0.5, density)) + 6;
    for (let i = 0; i < count; i++) {
      // Climbers start narrow at the root and fan out; hanging growth is widest at the top.
      const t = random();
      const v = vine.hanging ? vine.height * (1 - t * t) : 0.35 + (vine.height - 0.35) * Math.sqrt(t);
      const spread = vine.hanging ? 0.45 + 0.55 * (v / vine.height) : Math.min(1, 0.2 + v / 2.4);
      const u = (random() * 2 - 1) * (vine.width / 2) * spread;
      const out = 0.04 + random() * 0.16;
      const size = 0.8 + random() * 0.9;
      const card = new THREE.PlaneGeometry(size, size);
      const flowering = vine.flowers && random() < 0.6;
      const uv = card.getAttribute('uv');
      for (let k = 0; k < uv.count; k++) uv.setX(k, (uv.getX(k) + (flowering ? 1 : 0)) / 2);
      // Spin in its own plane, lean a little off the wall, then turn to face out of it.
      matrix.makeRotationFromEuler(euler.set((random() - 0.5) * 0.5, (random() - 0.5) * 0.5, random() * Math.PI * 2, 'XYZ'));
      matrix.premultiply(turn.makeRotationY(yaw));
      matrix.setPosition(vine.x + vine.nz * u + vine.nx * out, vine.base + v, vine.z - vine.nx * u + vine.nz * out);
      card.applyMatrix4(matrix);
      batch.add(material, card);
    }
    if (!vine.hanging) {
      // Woody stems up from the paving.
      const reach = Math.min(2.2, vine.height * 0.45);
      for (const du of [-0.09, 0.11]) {
        batch.box(mats.crate, 0.05, reach, 0.05, vine.x + vine.nz * du + vine.nx * 0.05, vine.base + reach / 2, vine.z - vine.nx * du + vine.nz * 0.05, { roll: du, tile: 1 });
      }
    }
  }

}
