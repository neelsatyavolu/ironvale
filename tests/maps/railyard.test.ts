import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { seededRandom } from '../../src/core/random';
import { corrugatedPanel } from '../../src/maps/railyard/containers';
import { beaconLit, flickerLevel, LIGHTING } from '../../src/maps/railyard/lighting';
import {
  BOUNDS,
  CONTAINER,
  DOORS,
  ENEMY_SPAWNS,
  OFFICE,
  PLAYER_SPAWNS,
  planContainers,
  TRAILER,
  WAREHOUSE,
  YARD,
  type ContainerSpot,
} from '../../src/maps/railyard/plan';

const CAPSULE_RADIUS = 0.34;
const spots = planContainers(seededRandom(1234));
const solidStacks = spots.filter((spot) => spot.stackBase && !spot.backdrop);

/** Corners of a stack's footprint in world space. */
function footprint(spot: ContainerSpot, grow = 0): [number, number][] {
  const halfW = CONTAINER.width / 2 + grow;
  const halfL = (spot.long ? CONTAINER.length40 : CONTAINER.length20) / 2 + grow;
  const cos = Math.cos(spot.yaw);
  const sin = Math.sin(spot.yaw);
  return [
    [-halfW, -halfL],
    [halfW, -halfL],
    [halfW, halfL],
    [-halfW, halfL],
  ].map(([lx, lz]) => [spot.x + (lx as number) * cos + (lz as number) * sin, spot.z - (lx as number) * sin + (lz as number) * cos]);
}

/** Separating-axis test for two convex quads. */
function overlap(a: [number, number][], b: [number, number][]): boolean {
  for (const quad of [a, b]) {
    for (let i = 0; i < 4; i++) {
      const [x0, z0] = quad[i] as [number, number];
      const [x1, z1] = quad[(i + 1) % 4] as [number, number];
      const axis: [number, number] = [z1 - z0, x0 - x1];
      const project = (points: [number, number][]) => points.map(([x, z]) => x * axis[0] + z * axis[1]);
      const pa = project(a);
      const pb = project(b);
      if (Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa)) return false;
    }
  }
  return true;
}

function insideQuad(x: number, z: number, quad: [number, number][]): boolean {
  return overlap(quad, [
    [x - 1e-3, z - 1e-3],
    [x + 1e-3, z - 1e-3],
    [x + 1e-3, z + 1e-3],
    [x - 1e-3, z + 1e-3],
  ]);
}

describe('railyard container plan', () => {
  it('is the same for the same seed and different for another', () => {
    expect(planContainers(seededRandom(1234))).toEqual(spots);
    expect(planContainers(seededRandom(99))).not.toEqual(spots);
  });

  it('keeps every solid container in the same place whatever the seed, so colliders never move', () => {
    const solid = (list: ContainerSpot[]) => list.filter((s) => !s.backdrop).map((s) => [s.x, s.z, s.y, s.long, s.stackLevels]);
    expect(solid(planContainers(seededRandom(99)))).toEqual(solid(spots));
  });

  it('never puts two solid stacks at the same level through each other', () => {
    for (let i = 0; i < solidStacks.length; i++) {
      for (let j = i + 1; j < solidStacks.length; j++) {
        const a = solidStacks[i] as ContainerSpot;
        const b = solidStacks[j] as ContainerSpot;
        if (Math.abs(a.y - b.y) > 0.5) continue;
        expect(overlap(footprint(a, -0.01), footprint(b, -0.01)), `stacks at (${a.x}, ${a.z}) and (${b.x}, ${b.z})`).toBe(false);
      }
    }
  });

  it('keeps solid stacks inside the yard and scenery stacks outside it', () => {
    for (const spot of spots.filter((s) => s.stackBase)) {
      const inside = footprint(spot).every(([x, z]) => x > YARD.west && x < YARD.east && z > YARD.quay && z < YARD.south);
      const outside = footprint(spot).every(([x, z]) => x < YARD.west || x > YARD.east || z < YARD.quay || z > YARD.south);
      if (spot.backdrop) expect(outside, `scenery stack at (${spot.x}, ${spot.z})`).toBe(true);
      else expect(inside, `solid stack at (${spot.x}, ${spot.z})`).toBe(true);
    }
  });

  it('stacks real containers: 2.59 m per level, on the ground, a wagon deck or the ship', () => {
    for (const spot of spots.filter((s) => !s.backdrop && s.stackBase)) expect([0, 1.2, TRAILER.deck]).toContain(spot.y);
    const levels = spots.filter((s) => s.x === -10.5 && s.z < -20).map((s) => s.y);
    for (const y of levels) expect(y % CONTAINER.height).toBeCloseTo(0, 6);
  });

  it('leaves lanes wide enough for a soldier between the rows', () => {
    const rowXs = [...new Set(solidStacks.filter((s) => s.yaw % Math.PI === 0 && s.z > -29 && s.z < 34 && Math.abs(s.x) < 17).map((s) => s.x))].sort((a, b) => a - b);
    const gaps = rowXs.slice(1).map((x, i) => x - (rowXs[i] as number) - CONTAINER.width);
    // Rows either touch (a double row) or leave a real lane; nothing in between that a bot could wedge into.
    for (const gap of gaps) expect(gap < 0.1 || gap > 2).toBe(true);
    expect(gaps.filter((gap) => gap > 2).length).toBeGreaterThanOrEqual(3);
  });
});

describe('railyard spawns', () => {
  const all = [...PLAYER_SPAWNS, ...ENEMY_SPAWNS];

  it('has four player spawns at the south end facing north', () => {
    expect(PLAYER_SPAWNS).toHaveLength(4);
    for (const spawn of PLAYER_SPAWNS) {
      expect(spawn.z).toBeGreaterThan(40);
      expect(spawn.yaw).toBe(0);
    }
  });

  it('hides every player spawn from the far end of each long lane, so nobody is shot as they appear', () => {
    // Eye points at the north mouth of the west lane, the avenue (both sides and the middle) and the track-side lane.
    const watchers: [number, number][] = [[-8.8, -28], [-5, -28], [1, -28], [4, -28], [7, -28], [17.4, -28], [21, -28], [4, -44], [-6.9, -44]];
    for (const spawn of PLAYER_SPAWNS) {
      for (const [x, z] of watchers) {
        const dx = spawn.x - x;
        const dz = spawn.z - z;
        const length = Math.hypot(dx, dz);
        const nx = (-dz / length) * 0.01;
        const nz = (dx / length) * 0.01;
        const ray: [number, number][] = [[x - nx, z - nz], [spawn.x - nx, spawn.z - nz], [spawn.x + nx, spawn.z + nz], [x + nx, z + nz]];
        const blocked = solidStacks.some((stack) => stack.y < 1 && overlap(ray, footprint(stack)));
        expect(blocked, `spawn (${spawn.x}, ${spawn.z}) seen from (${x}, ${z})`).toBe(true);
      }
    }
  });

  it('has at least ten enemy spawns, all in the far half or well out on a flank', () => {
    expect(ENEMY_SPAWNS.length).toBeGreaterThanOrEqual(10);
    for (const spawn of ENEMY_SPAWNS) {
      expect(spawn.z).toBeLessThan(0);
      for (const player of PLAYER_SPAWNS) expect(Math.hypot(spawn.x - player.x, spawn.z - player.z)).toBeGreaterThan(40);
    }
    expect(Math.max(...ENEMY_SPAWNS.map((s) => s.x)) - Math.min(...ENEMY_SPAWNS.map((s) => s.x))).toBeGreaterThan(60);
  });

  it('keeps every spawn inside the bounds and clear of every container', () => {
    for (const spawn of all) {
      expect(spawn.x).toBeGreaterThan(BOUNDS.min[0] + 1);
      expect(spawn.x).toBeLessThan(BOUNDS.max[0] - 1);
      expect(spawn.z).toBeGreaterThan(BOUNDS.min[2] + 1);
      expect(spawn.z).toBeLessThan(BOUNDS.max[2] - 1);
      for (const stack of solidStacks.filter((s) => s.y === 0)) {
        expect(insideQuad(spawn.x, spawn.z, footprint(stack, CAPSULE_RADIUS + 0.4)), `spawn (${spawn.x}, ${spawn.z}) near stack (${stack.x}, ${stack.z})`).toBe(false);
      }
    }
  });

  it('does not put two spawns on top of each other', () => {
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const a = all[i] as (typeof all)[number];
        const b = all[j] as (typeof all)[number];
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(1.5);
      }
    }
  });
});

describe('railyard dimensions', () => {
  it('is 80 to 110 m across and the bounds enclose the yard', () => {
    const width = YARD.east - YARD.west;
    const length = YARD.south - YARD.quay;
    expect(width).toBeGreaterThanOrEqual(80);
    expect(width).toBeLessThanOrEqual(110);
    expect(length).toBeGreaterThanOrEqual(80);
    expect(length).toBeLessThanOrEqual(110);
    expect(BOUNDS.min[0]).toBeLessThanOrEqual(YARD.west);
    expect(BOUNDS.max[0]).toBeGreaterThanOrEqual(YARD.east);
    expect(BOUNDS.min[2]).toBeLessThanOrEqual(YARD.quay);
    expect(BOUNDS.max[2]).toBeGreaterThanOrEqual(YARD.south);
    expect(BOUNDS.max[1]).toBeGreaterThan(WAREHOUSE.ridge);
  });

  it('uses real sizes for containers, doors and the mezzanine stair', () => {
    expect(CONTAINER.length20).toBeCloseTo(6.06, 1);
    expect(CONTAINER.width).toBeCloseTo(2.44, 2);
    expect(CONTAINER.height).toBeCloseTo(2.59, 2);
    // 18 risers reach the deck, so each is 0.17 m: under the 0.18 m the capsule can climb.
    expect(WAREHOUSE.mezzanine.top / 18).toBeLessThanOrEqual(0.18);
    expect(OFFICE.height).toBeGreaterThan(2.4);
  });

  it('centres each 0.95 m personnel door on a column of the bots\' 0.6 m navigation grid', () => {
    for (const door of Object.values(DOORS)) {
      expect(door.east - door.west).toBeCloseTo(0.95, 2);
      const column = ((door.west + door.east) / 2 - BOUNDS.min[0]) / 0.6 - 0.5;
      expect(Math.abs(column - Math.round(column))).toBeLessThan(0.1);
    }
  });
});

describe('railyard lighting', () => {
  it('turns the sky so the sun in the HDRI sits where the directional light is', () => {
    // Measured by scripts/dev/map-railyard-sun.mjs on freight_station_1k.hdr.
    const azimuth = (35.96 * Math.PI) / 180;
    const elevation = (9.38 * Math.PI) / 180;
    const inTexture = new Vector3(Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.sin(azimuth));
    const inWorld = inTexture.clone().applyAxisAngle(new Vector3(0, 1, 0), LIGHTING.hdriRotation);
    expect(inWorld.angleTo(LIGHTING.sunDirection)).toBeLessThan(0.002);
  });

  it('has a low sun to the north, a little west, as a unit vector', () => {
    const sun = LIGHTING.sunDirection;
    expect(sun.length()).toBeCloseTo(1, 6);
    expect(sun.z).toBeLessThan(-0.9);
    expect(sun.x).toBeLessThan(0);
    expect((Math.asin(sun.y) * 180) / Math.PI).toBeCloseTo(9.38, 1);
  });

  it('flashes the gantry beacons briefly, about once a second', () => {
    const samples = Array.from({ length: 1100 }, (_, i) => beaconLit(i / 100));
    const lit = samples.filter(Boolean).length / samples.length;
    expect(lit).toBeGreaterThan(0.1);
    expect(lit).toBeLessThan(0.3);
    expect(beaconLit(0)).toBe(true);
    expect(beaconLit(0.6)).toBe(false);
  });

  it('flickers between full and dim only', () => {
    const levels = new Set<number>();
    for (let t = 0; t < 60; t += 0.013) levels.add(flickerLevel(t));
    expect([...levels].sort()).toEqual([0.25, 1]);
  });
});

describe('corrugated panel', () => {
  it('spans the requested size with crests at the face and troughs behind it', () => {
    const panel = corrugatedPanel(5.7, 2.3, 0.036, 0.278, 1.94);
    panel.computeBoundingBox();
    const box = panel.boundingBox;
    expect(box?.min.x).toBeCloseTo(-2.85, 5);
    expect(box?.max.x).toBeCloseTo(2.85, 5);
    expect(box?.min.y).toBeCloseTo(0, 5);
    expect(box?.max.y).toBeCloseTo(2.3, 5);
    expect(box?.max.z).toBeCloseTo(0, 5);
    expect(box?.min.z).toBeCloseTo(-0.036, 5);
  });

  it('faces +Z on every flat', () => {
    const panel = corrugatedPanel(2, 1, 0.04, 0.25, 2);
    const normal = panel.getAttribute('normal');
    for (let i = 0; i < normal.count; i++) expect(normal.getZ(i)).toBeGreaterThan(0.3);
  });
});
