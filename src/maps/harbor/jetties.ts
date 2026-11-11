import * as THREE from 'three/webgpu';
import type { Kit } from './facade';
import { JETTIES, QUAY_EDGE, SEABED_Y, type Jetty } from './layout';

/** Timber jetties on piles, flush with the quay. */
export function addJetties(kit: Kit): void {
  for (const jetty of JETTIES) addJetty(kit, jetty);
}

function addJetty(kit: Kit, jetty: Jetty): void {
  const { batch, colliders, mats } = kit;
  const x0 = jetty.x - jetty.width / 2;
  const x1 = jetty.x + jetty.width / 2;
  const z0 = QUAY_EDGE + 0.06;
  const z1 = QUAY_EDGE + jetty.length;
  const deck = (ax: number, bx: number, az: number, bz: number): void => {
    batch.span(mats.planksPale, ax, bx, -0.07, 0, az, bz, { tile: 1.5, swap: true });
    batch.span(mats.planks, ax + 0.12, ax + 0.3, -0.3, -0.07, az, bz, { tile: 1.5 });
    batch.span(mats.planks, bx - 0.3, bx - 0.12, -0.3, -0.07, az, bz, { tile: 1.5 });
    colliders.span(ax, bx, -0.34, 0, az, bz, 'wood');
  };
  deck(x0, x1, z0, z1);
  if (jetty.head > 0) {
    deck(jetty.x - jetty.head, x0, z1 - 2.8, z1);
    deck(x1, jetty.x + jetty.head, z1 - 2.8, z1);
  }

  const pile = (x: number, z: number, tall: boolean): void => {
    const top = tall ? 0.85 + kit.random() * 0.25 : 0.04;
    const bottom = SEABED_Y - 0.3;
    const geometry = new THREE.CylinderGeometry(0.12, 0.14, top - bottom, 10);
    batch.place(mats.planks, geometry, x, (top + bottom) / 2, z, kit.random() * 3);
    geometry.dispose();
    if (tall) colliders.box(0.26, top, 0.26, x, top / 2, z, 'wood');
  };
  const bays = Math.max(2, Math.round((z1 - z0) / 3.2));
  for (let i = 1; i <= bays; i++) {
    const z = z0 + ((z1 - z0) * i) / bays - 0.25;
    const tall = i % 2 === 0;
    pile(x0 - 0.1, z, tall);
    pile(x1 + 0.1, z, tall && i !== bays);
    batch.span(mats.planks, x0 - 0.2, x1 + 0.2, -0.46, -0.3, z - 0.08, z + 0.08, { tile: 1.5, swap: true });
  }
  if (jetty.head > 0) {
    for (const x of [jetty.x - jetty.head + 0.1, jetty.x + jetty.head - 0.1]) {
      pile(x, z1 - 0.2, true);
      pile(x, z1 - 2.6, false);
    }
  }
}
