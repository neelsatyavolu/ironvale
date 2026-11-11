import { MeshBuilder } from './builder';
import type { Clutter } from './clutter';
import type { Kit } from './kit';
import type { Materials } from './materials';
import { YARD } from './plan';
import { buildRelay, buildTarp, cableCoil, groundCable } from './plant';
import { strut } from './shapes';

const HALF_PI = Math.PI / 2;
const YELLOW = 0xd2a012;
const RED = 0x8f1f18;
const PALE = 0xe6e3da;
const INK = 0x141516;
const GALVANISED = 0x9a9d9c;
const FENCE_TOP = 3;

/**
 * Second pass of dressing: the relay cabinets with their lit strips, power
 * cables across the paving, tarpaulins over some of the crates, razor wire on
 * the fence and the warning signs. The cabinets stand hard against a mast, a
 * wall or a corner that was already blocked, so no route changes.
 */
export function dressPlant(kit: Kit, m: Materials, c: Clutter): void {
  buildRelay(kit, m, 20.9, 37.98, 0, 'RELAY 01');
  buildRelay(kit, m, 33.3, -8.02, 0, 'RELAY 02');
  buildRelay(kit, m, -10.85, -33.4, 0, 'RELAY 03');
  buildRelay(kit, m, 24, 49.62, Math.PI, 'RELAY 01');
  buildRelay(kit, m, -41.62, -36, HALF_PI, 'RELAY 03');

  // Supply cables: generator to office, quay generator to its cabinet, cabinet to crane, and the gate run.
  groundCable(kit, m, [[39.9, 20.3], [39.5, 19.6], [40.2, 19.05], [40.0, 18.56]], 0.028);
  groundCable(kit, m, [[-39.3, -42.35], [-40.4, -41], [-40.9, -38.5], [-41.3, -36.6]], 0.028);
  groundCable(kit, m, [[-10.5, -33.05], [-9.6, -32.2], [-8.8, -32.9], [-8.2, -32.7]]);
  groundCable(kit, m, [[-10.6, -33.1], [-9.5, -31.9], [-8.6, -32.6], [-8.2, -32.5]]);
  groundCable(kit, m, [[21.25, 38.5], [21.4, 41], [21.15, 44], [21.45, 47], [22.5, 48.9], [23.6, 49.3]]);
  groundCable(kit, m, [[32.9, -8.3], [32.6, -10.5], [32.7, -13], [33.1, -17], [32.8, -21], [33.2, -25.2]]);
  cableCoil(kit, m, -12.0, 39.3, 0.42, -10.5, 40.5);
  cableCoil(kit, m, 5.6, 23.0, 0.38, 4.6, 24.3);
  cableCoil(kit, m, -17.4, -42.5, 0.42, -15.6, -43.1);

  buildTarp(kit, m, -19.8, 34.5, 1.92, 1.42, 1.42, 0.3, 0x24507a);
  buildTarp(kit, m, 17.9, -22, 1.92, 1.47, 1.42, HALF_PI, 0x2f5a44);
  buildTarp(kit, m, -29, -43, 2.32, 1.47, 1.52, 0.1, 0x24507a);

  razorWire(kit, m);

  // Warning plates on the fence, the gantry legs and the quay wall.
  const fence = YARD.east - 0.07;
  c.plate(fence, 2.1, 27, -1, 0, 'AUTHORISED ONLY', 1.5, RED, PALE);
  c.plate(fence, 2.1, -4, -1, 0, 'CAUTION', 1.1, YELLOW, INK);
  c.plate(fence, 2.1, -24, -1, 0, 'NO ENTRY', 1.2, RED, PALE);
  c.plate(fence, 2.1, 44, -1, 0, 'NO ENTRY', 1.2, RED, PALE);
  c.plate(-14.4, 5.0, 10.44, 0, 1, 'CAUTION', 0.8, YELLOW, INK);
  c.plate(19, 5.0, 10.44, 0, 1, 'CAUTION', 0.8, YELLOW, INK);
  c.plate(-14.4, 5.0, 1.56, 0, -1, 'KEEP CLEAR', 0.8, YELLOW, INK);
  c.plate(19, 5.0, 1.56, 0, -1, 'KEEP CLEAR', 0.8, YELLOW, INK);
  c.plate(YARD.west + 0.02, 2.3, -40, 1, 0, 'HIGH VOLTAGE', 1.4, YELLOW, INK);
}

/** Concertina wire along the top of the east fence: one long coil carried on the cranked arms. */
function razorWire(kit: Kit, m: Materials): void {
  const coil = new MeshBuilder();
  const radius = 0.21;
  const pitch = 0.46;
  const steps = 8;
  const x = YARD.east - 0.2;
  const y = FENCE_TOP + 0.3;
  const turns = Math.floor((YARD.south - YARD.quay) / pitch);
  let previous: [number, number, number] = [x + radius, y, YARD.quay];
  for (let i = 1; i <= turns * steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    // Alternate turns lean the other way, which is what makes a concertina.
    const lean = Math.floor(i / steps) % 2 === 0 ? 0.1 : -0.1;
    const next: [number, number, number] = [x + Math.cos(angle) * radius, y + Math.sin(angle) * radius, YARD.quay + (i / steps) * pitch + Math.sin(angle) * lean];
    strut(coil, previous, next, 0.012, GALVANISED);
    previous = next;
  }
  const geometry = coil.build();
  kit.add(m.rawSteel, geometry, kit.transform(0, 0, 0));
  geometry.dispose();
}
