import { describe, expect, it } from 'vitest';
import {
  CABIN,
  CREEK,
  ENEMY_SPAWNS,
  Heightfield,
  PADS,
  PLAY,
  PLAYER_SPAWNS,
  TRAIL,
  distanceOutside,
  distanceToPath,
  isKeptOut,
  pathAtZ,
  rectKeepOuts,
  surfaceAt,
  terrainHeight,
  terrainPaint,
} from '../../src/maps/pinewood/layout';

const field = new Heightfield();

describe('pinewood terrain', () => {
  it('samples the same height the height function gives at grid points', () => {
    for (const [x, z] of [[0, 0], [-30, 12], [41, -37], [-47, 53]] as const) {
      expect(field.sample(x, z)).toBeCloseTo(terrainHeight(x, z), 4);
    }
  });

  it('is continuous across the diagonal of a cell', () => {
    const a = field.sample(10.499, 20.501);
    const b = field.sample(10.501, 20.499);
    expect(Math.abs(a - b)).toBeLessThan(0.01);
  });

  it('never gets too steep to walk inside the play area', () => {
    let steepest = 0;
    for (let x = PLAY.minX + 1; x <= PLAY.maxX - 1; x += 1) {
      for (let z = PLAY.minZ + 1; z <= PLAY.maxZ - 1; z += 1) steepest = Math.max(steepest, field.slope(x, z));
    }
    // The capsule treats anything under about 56 degrees as ground; stay well below it.
    expect(steepest).toBeLessThan(Math.tan((42 * Math.PI) / 180));
  });

  it('rises into a bank all around the play area', () => {
    for (const [x, z] of [[PLAY.maxX + 6, 0], [PLAY.minX - 6, 10], [0, PLAY.maxZ + 6], [15, PLAY.minZ - 6]] as const) {
      const inside = terrainHeight(Math.sign(x) * Math.min(Math.abs(x), PLAY.maxX - 2), Math.sign(z) * Math.min(Math.abs(z), PLAY.maxZ - 2));
      expect(terrainHeight(x, z) - inside).toBeGreaterThan(3.5);
    }
  });

  it('keeps the cabin floor flat', () => {
    for (const [dx, dz] of [[0, 0], [CABIN.width / 2, CABIN.depth / 2], [-CABIN.width / 2, 0], [1, -CABIN.depth / 2]] as const) {
      expect(terrainHeight(CABIN.x + dx, CABIN.z + dz)).toBeCloseTo(PADS.cabin.height, 5);
    }
  });

  it('carves the creek below its banks', () => {
    const mid = CREEK[Math.floor(CREEK.length / 2)]!;
    expect(terrainHeight(mid.x + 8, mid.z) - terrainHeight(mid.x, mid.z)).toBeGreaterThan(1);
  });
});

describe('pinewood surfaces', () => {
  it('paints the trail as dirt, the creek bed as gravel and the rest as grass', () => {
    const trail = pathAtZ(TRAIL, 30);
    const creek = CREEK[Math.floor(CREEK.length / 2)]!;
    expect(surfaceAt(trail.x, trail.z)).toBe('dirt');
    expect(surfaceAt(creek.x, creek.z)).toBe('gravel');
    expect(surfaceAt(20, 30)).toBe('grass');
    expect(terrainPaint(trail.x, trail.z)[0]).toBeGreaterThan(0.8);
    expect(terrainPaint(creek.x, creek.z)[1]).toBeGreaterThan(0.8);
    expect(terrainPaint(20, 30)[0]).toBe(0);
  });

  it('keeps the trail and the creek apart', () => {
    for (const point of TRAIL) expect(distanceToPath(CREEK, point.x, point.z)).toBeGreaterThan(12);
  });
});

describe('pinewood routes and spawns', () => {
  it('has a sight line of 50 m or more down the trail', () => {
    // From just north of the outcrops that screen the player spawn.
    const from = pathAtZ(TRAIL, 40);
    const to = pathAtZ(TRAIL, -11.5);
    expect(Math.hypot(to.x - from.x, to.z - from.z)).toBeGreaterThan(50);
    // The straight line stays inside the corridor the trees are kept out of.
    for (let i = 0; i <= 50; i++) {
      const t = i / 50;
      expect(distanceToPath(TRAIL, from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t)).toBeLessThan(3.3);
    }
  });

  it('starts four players at the south end', () => {
    expect(PLAYER_SPAWNS).toHaveLength(4);
    for (const spawn of PLAYER_SPAWNS) {
      expect(spawn.z).toBeGreaterThan(44);
      expect(distanceOutside(PLAY, spawn.x, spawn.z)).toBe(0);
    }
  });

  it('spreads ten or more enemies over the far half and the flanks', () => {
    expect(ENEMY_SPAWNS.length).toBeGreaterThanOrEqual(10);
    for (const spawn of ENEMY_SPAWNS) {
      expect(spawn.z).toBeLessThan(0);
      expect(distanceOutside({ minX: PLAY.minX + 3, maxX: PLAY.maxX - 3, minZ: PLAY.minZ + 3, maxZ: PLAY.maxZ - 3 }, spawn.x, spawn.z)).toBe(0);
    }
    expect(ENEMY_SPAWNS.some((spawn) => spawn.x < -35)).toBe(true);
    expect(ENEMY_SPAWNS.some((spawn) => spawn.x > 35)).toBe(true);
  });

  it('spawns everyone on gentle ground and apart from each other', () => {
    const all = [...PLAYER_SPAWNS, ...ENEMY_SPAWNS];
    all.forEach((spawn, i) => {
      expect(field.slope(spawn.x, spawn.z)).toBeLessThan(0.45);
      for (const other of all.slice(i + 1)) expect(Math.hypot(other.x - spawn.x, other.z - spawn.z)).toBeGreaterThan(2);
    });
  });
});

describe('pinewood keep-outs', () => {
  it('covers a rectangle with circles, including its corners', () => {
    const keepOuts = rectKeepOuts(PADS.cabin, 0.9);
    for (const x of [PADS.cabin.minX, (PADS.cabin.minX + PADS.cabin.maxX) / 2, PADS.cabin.maxX]) {
      for (const z of [PADS.cabin.minZ, (PADS.cabin.minZ + PADS.cabin.maxZ) / 2, PADS.cabin.maxZ]) {
        expect(isKeptOut(keepOuts, x, z)).toBe(true);
      }
    }
    expect(isKeptOut(keepOuts, PADS.cabin.maxX + 6, PADS.cabin.maxZ + 6)).toBe(false);
  });
});
