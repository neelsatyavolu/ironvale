import * as THREE from 'three/webgpu';
import type { Kit } from './kit';
import type { Materials } from './materials';
import { CONTAINER, YARD, type ContainerSpot } from './plan';

const YELLOW = 0xd2a012;
const WHITE = 0xd6d4cb;
const LIFT = 0.004;

/** Painted yard markings: stack slots, lane edges, hatched keep-clear boxes, walkway and arrows. */
export function buildMarkings(kit: Kit, m: Materials, spots: readonly ContainerSpot[]): void {
  /** Painted strip from (x0, z0) to (x1, z1). */
  const line = (x0: number, z0: number, x1: number, z1: number, width: number, color: number): void => {
    const length = Math.hypot(x1 - x0, z1 - z0);
    const yaw = Math.atan2(x1 - x0, z1 - z0);
    kit.box(m.paint, width, 0.002, length, (x0 + x1) / 2, LIFT, (z0 + z1) / 2, { yaw, color });
  };

  const hatch = (x0: number, x1: number, z0: number, z1: number): void => {
    line(x0, z0, x1, z0, 0.12, YELLOW);
    line(x0, z1, x1, z1, 0.12, YELLOW);
    line(x0, z0, x0, z1, 0.12, YELLOW);
    line(x1, z0, x1, z1, 0.12, YELLOW);
    const depth = z1 - z0;
    for (let x = x0 - depth + 1.2; x < x1; x += 1.2) {
      // Clip each diagonal to the box.
      const start = Math.max(x, x0);
      const end = Math.min(x + depth, x1);
      if (end - start < 0.3) continue;
      line(start, z0 + (start - x), end, z0 + (end - x), 0.12, YELLOW);
    }
  };

  // Slot outline around every stack that stands on the yard.
  for (const spot of spots) {
    if (!spot.stackBase || spot.backdrop || spot.y > 0) continue;
    const halfW = CONTAINER.width / 2 + 0.22;
    const halfL = (spot.long ? CONTAINER.length40 : CONTAINER.length20) / 2 + 0.1;
    const corner = (sx: number, sz: number): [number, number] => {
      const lx = sx * halfW;
      const lz = sz * halfL;
      return [spot.x + lx * Math.cos(spot.yaw) + lz * Math.sin(spot.yaw), spot.z - lx * Math.sin(spot.yaw) + lz * Math.cos(spot.yaw)];
    };
    const ring = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
    ring.forEach(([x, z], i) => {
      const [nx, nz] = ring[(i + 1) % 4] as [number, number];
      line(x, z, nx, nz, 0.1, YELLOW);
    });
  }

  // Central avenue: edge lines and a broken centre line.
  line(1.1, -29, 1.1, 33.5, 0.15, YELLOW);
  line(6.9, -29, 6.9, 33.5, 0.15, YELLOW);
  for (let z = -27; z < 32; z += 6) line(4, z, 4, z + 2.4, 0.12, WHITE);
  hatch(1.3, 6.7, -8.6, -4.3);
  hatch(1.3, 6.7, 15.8, 19.9);

  // Walkway along the warehouse, with zebra bars where it crosses the doors' line.
  line(-17.4, -29, -17.4, 34, 0.1, WHITE);
  line(-16.1, -29, -16.1, 34, 0.1, WHITE);
  for (let z = 21; z < 27; z += 0.9) line(-17.4, z, -16.1, z, 0.45, WHITE);
  for (let z = -29; z < -24.5; z += 0.9) line(-17.4, z, -16.1, z, 0.45, WHITE);

  // Quay: a broad safety line back from the edge and boxes around the crane sills.
  line(YARD.west, YARD.quay + 1.8, YARD.east, YARD.quay + 1.8, 0.3, YELLOW);
  line(YARD.west, YARD.apron + 0.4, YARD.east, YARD.apron + 0.4, 0.15, YELLOW);
  hatch(-27, -21, -40.5, -35.5);
  hatch(-9, -3, -40.5, -35.5);

  // Gate: stop line and parking bays against the south wall.
  line(-3.6, 47.3, 3.6, 47.3, 0.4, WHITE);
  for (let x = 13; x <= 20.5; x += 2.5) line(x, 43.5, x, 49.5, 0.1, WHITE);
  hatch(-40, -34, 36, 41);

  // Direction arrows on the avenue and the west road.
  const arrow = (x: number, z: number, heading: number): void => {
    const shape = new THREE.Shape();
    shape.moveTo(-0.12, -1.3);
    shape.lineTo(0.12, -1.3);
    shape.lineTo(0.12, 0.4);
    shape.lineTo(0.45, 0.4);
    shape.lineTo(0, 1.3);
    shape.lineTo(-0.45, 0.4);
    shape.lineTo(-0.12, 0.4);
    shape.closePath();
    // ShapeGeometry lies in XY facing +Z; lay it flat with its +Y pointing north.
    const geometry = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
    kit.add(m.paint, geometry, kit.transform(x, LIFT + 0.002, z, heading), WHITE);
    geometry.dispose();
  };
  arrow(2.6, 24, 0);
  arrow(5.4, 0, Math.PI);
  arrow(2.6, -20, 0);
  arrow(-14.2, 30, 0);
  arrow(-14.2, -18, 0);
}
