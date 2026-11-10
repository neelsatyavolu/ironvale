import type { Kit } from './facade';
import { QUAY_NORTH, STREET_NORTH, STREET_SOUTH } from './layout';

type Point = readonly [x: number, y: number, z: number];

/** Overhead lines strung between facades: [from, to, sag in metres]. */
const SPANS: readonly (readonly [Point, Point, number])[] = [
  [[40.5, 5.7, STREET_SOUTH], [39.2, 5.9, STREET_NORTH], 0.35],
  [[27.5, 6.4, STREET_SOUTH], [24.5, 5.6, STREET_NORTH], 0.4],
  [[15.5, 5.6, STREET_SOUTH], [17.5, 6.6, STREET_NORTH], 0.45],
  [[-18.5, 6.5, STREET_SOUTH], [-22.5, 6.1, STREET_NORTH], 0.4],
  [[-27.5, 5.6, STREET_SOUTH], [-27, 6.6, STREET_NORTH], 0.3],
  [[-44.5, 5.7, STREET_SOUTH], [-46.5, 6.3, STREET_NORTH], 0.4],
  [[33, 6.2, 4.5], [36.5, 5.8, 7.5], 0.25],
  [[-38, 5.6, 7.2], [-35.5, 5.9, 4.4], 0.2],
];

/** Runs of cable clipped along a facade: [x0, x1, wall z, facing, height]. A meter box hangs under one end. */
const WALL_RUNS: readonly (readonly [number, number, number, 1 | -1, number])[] = [
  [-51.5, -38.5, QUAY_NORTH, 1, 3.3],
  [-24.5, -16.5, QUAY_NORTH, 1, 6.25],
  [13.5, 32.5, QUAY_NORTH, 1, 3.28],
  [37, 51.5, QUAY_NORTH, 1, 3.3],
  [-51.5, -38.5, STREET_SOUTH, -1, 3.28],
  [-35, -16.5, STREET_SOUTH, -1, 3.3],
  [3.5, 32.5, STREET_SOUTH, -1, 3.3],
  [-51.5, -32.5, STREET_NORTH, 1, 3.32],
  [-29, -12.5, STREET_NORTH, 1, 3.32],
  [12.5, 29.5, STREET_NORTH, 1, 3.32],
  [34.5, 51.5, STREET_NORTH, 1, 3.32],
];

const SEGMENTS = 8;

/** Electricity and telephone lines: the untidy detail every old town street has. */
export function addWires(kit: Kit): void {
  const { batch, mats, random } = kit;

  for (const [a, b, sag] of SPANS) {
    let previous: Point = a;
    for (let i = 1; i <= SEGMENTS; i++) {
      const t = i / SEGMENTS;
      const next: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t];
      const dx = next[0] - previous[0];
      const dy = next[1] - previous[1];
      const dz = next[2] - previous[2];
      const length = Math.hypot(dx, dy, dz);
      batch.box(mats.iron, 0.018, 0.018, length + 0.01, (previous[0] + next[0]) / 2, (previous[1] + next[1]) / 2, (previous[2] + next[2]) / 2, {
        yaw: Math.atan2(dx, dz),
        pitch: -Math.asin(dy / length),
      });
      previous = next;
    }
  }

  for (const [x0, x1, z, facing, y] of WALL_RUNS) {
    const zc = z + facing * 0.025;
    batch.box(mats.iron, x1 - x0, 0.022, 0.022, (x0 + x1) / 2, y, zc);
    batch.box(mats.iron, x1 - x0, 0.016, 0.016, (x0 + x1) / 2, y + 0.07, zc);
    // Clips, then a drop to a meter box at one end.
    for (let x = x0 + 0.4; x < x1; x += 1.6 + random() * 0.5) batch.box(mats.iron, 0.03, 0.12, 0.03, x, y + 0.035, zc);
    const end = random() < 0.5 ? x0 + 0.5 : x1 - 0.5;
    batch.box(mats.iron, 0.022, y - 1.75, 0.022, end, (y + 1.75) / 2, zc);
    batch.box(mats.fishBox[1]!, 0.3, 0.42, 0.13, end, 1.55, z + facing * 0.065);
    batch.box(mats.iron, 0.32, 0.03, 0.15, end, 1.775, z + facing * 0.075);
  }
}
