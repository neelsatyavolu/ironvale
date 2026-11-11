import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { NAV } from '../../src/ai/navgrid';
import { registerColliders } from '../../src/maps/headworks/colliders';
import {
  BLOCKS,
  COVER_HIGH,
  COVER_LOW,
  DECK_HEIGHT,
  DECKS,
  DRUMS,
  ENEMY_SPAWNS,
  HALF_X,
  HALF_Z,
  HOUSE,
  HOUSES,
  PLAYER_SPAWNS,
  RAILS,
  RAMPS,
  turnBlock,
  turnDrum,
  turnRail,
  turnRamp,
  turnSpot,
  type Block,
  type Spot,
} from '../../src/maps/headworks/plan';
import { CollisionWorld } from '../../src/world/collision';

const EYE = 1.6;
const SIGHT_CAP = 45;
const SAMPLE_STEP = 2;
const BODY_RADIUS = 0.34;
const BODY_HEIGHT = 1.8;

/** Node's process, reached without its type definitions (the project does not load them). */
const node = (globalThis as { process?: { env: Record<string, string | undefined>; stdout: { write(text: string): void } } }).process;

const world = new CollisionWorld();
registerColliders(world);
world.build();

const strip = <P extends { id: string }>(piece: P): Omit<P, 'id'> => {
  const { id: _id, ...rest } = piece;
  return rest;
};
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
const sameShape = (a: object, b: object): boolean =>
  Object.entries(a).every(([key, value]) => {
    const other = (b as Record<string, unknown>)[key];
    return typeof value === 'number' ? near(value, other as number) : value === other;
  });
const insideBlock = (b: Block, x: number, z: number, grow = 0): boolean =>
  x > b.x0 - grow && x < b.x1 + grow && z > b.z0 - grow && z < b.z1 + grow;

interface Stand {
  readonly eye: Vector3;
  readonly raised: boolean;
}

/** Every place a soldier can stand, on a grid: the ground, the two terraces and their ramps. */
function standingPoints(step: number): Stand[] {
  const points: Stand[] = [];
  for (let x = -HALF_X + 0.7; x < HALF_X; x += step) {
    for (let z = -HALF_Z + 0.7; z < HALF_Z; z += step) {
      const onRamp = RAMPS.some(
        (r) =>
          x > Math.min(r.footX, r.topX) && x < Math.max(r.footX, r.topX) && Math.abs(z - r.footZ) < r.width / 2 - 0.3,
      );
      const onDeck = DECKS.some((d) => insideBlock(d, x, z, -0.4));
      const floor = world.groundHeight(x, z, onDeck || onRamp ? DECK_HEIGHT + 0.3 : 0.3, 3);
      if (floor === null) continue;
      if (!onDeck && !onRamp && floor > 0.05) continue;
      const feet = new Vector3(x, floor + 0.03, z);
      if (!world.capsuleFits(feet, BODY_RADIUS, BODY_HEIGHT)) continue;
      points.push({ eye: new Vector3(x, floor + EYE, z), raised: floor > 1 });
    }
  }
  return points;
}

const stands = standingPoints(SAMPLE_STEP);

/** Plan for reading the layout: one character is 1 m by 2 m, north is up. Set HEADWORKS_REPORT=1 to print it. */
function planView(): string {
  const rows: string[] = [];
  for (let z = -HALF_Z + 1; z < HALF_Z; z += 2) {
    let row = '';
    for (let x = -HALF_X + 0.5; x < HALF_X; x += 1) {
      const spawn = PLAYER_SPAWNS.some((s) => Math.abs(s.x - x) <= 0.5 && Math.abs(s.z - z) <= 1)
        ? 'P'
        : ENEMY_SPAWNS.some((s) => Math.abs(s.x - x) <= 0.5 && Math.abs(s.z - z) <= 1)
          ? 'E'
          : '';
      const top = world.groundHeight(x, z, 9, 12) ?? 0;
      row += spawn || (top < 0.05 ? '.' : top < 1.5 ? 'o' : top < 2.6 ? '=' : top < 4 ? 'H' : '#');
    }
    rows.push(row);
  }
  return rows.join('\n');
}

describe('headworks plan', () => {
  it('is point-symmetric: every solid, ramp and rail has a twin turned 180 degrees', () => {
    const check = <P extends { id: string }>(pieces: readonly P[], turn: (piece: P) => P): void => {
      for (const piece of pieces) {
        const twin = strip(turn(piece));
        const found = pieces.some((other) => sameShape(twin, strip(other)));
        expect(found, `${piece.id} has no twin`).toBe(true);
      }
    };
    check(BLOCKS, turnBlock);
    check(DRUMS, turnDrum);
    check(RAMPS, turnRamp);
    check(RAILS, turnRail);
    expect(HOUSES).toHaveLength(2);
  });

  it('builds cover at crouch height or standing height and never in between', () => {
    for (const b of BLOCKS) {
      if (b.role === 'roof' || b.id.includes('lintel')) continue;
      const low = b.h >= NAV.coverLowHeight && b.h < NAV.coverHighHeight;
      const high = b.h >= COVER_HIGH;
      expect(low || high, `${b.id} is ${b.h} m tall`).toBe(true);
      if (low) expect(b.h, b.id).toBeCloseTo(COVER_LOW, 6);
    }
    for (const d of DRUMS) expect(d.h, d.id).toBeGreaterThanOrEqual(COVER_HIGH);
  });

  it('keeps doors and ceilings big enough for the bots', () => {
    expect(HOUSE.door).toBeGreaterThanOrEqual(1.2);
    for (const b of BLOCKS.filter((piece) => piece.y > 0 && piece.role !== 'parapet')) expect(b.y, b.id).toBeGreaterThanOrEqual(2.4);
    for (const ramp of RAMPS) {
      const run = Math.hypot(ramp.topX - ramp.footX, ramp.topZ - ramp.footZ);
      expect(ramp.rise / run, ramp.id).toBeLessThan(0.4);
      expect(ramp.width, ramp.id).toBeGreaterThanOrEqual(2.4);
    }
  });

  it('gives each pump house three doors', () => {
    for (const side of ['', '-east']) {
      const lintels = BLOCKS.filter((b) => b.id.startsWith('house-') && b.id.includes('lintel') && b.id.endsWith('-east') === (side !== ''));
      expect(lintels).toHaveLength(3);
    }
  });

  it('keeps the solid pieces of one side from running through each other on the ground', () => {
    const grounded = BLOCKS.filter((b) => b.y === 0 && b.role !== 'perimeter' && b.role !== 'house');
    for (let i = 0; i < grounded.length; i++) {
      for (let j = i + 1; j < grounded.length; j++) {
        const a = grounded[i] as Block;
        const b = grounded[j] as Block;
        const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.01 && Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0) > 0.01;
        expect(overlap, `${a.id} and ${b.id}`).toBe(false);
      }
    }
  });
});

describe('headworks spawns', () => {
  const all: readonly Spot[] = [...PLAYER_SPAWNS, ...ENEMY_SPAWNS];

  it('puts every spawn on open ground with room around it', () => {
    for (const spot of all) {
      const name = `spawn (${spot.x}, ${spot.z})`;
      expect(Math.abs(spot.x) < HALF_X - 0.8 && Math.abs(spot.z) < HALF_Z - 0.8, name).toBe(true);
      expect(world.groundHeight(spot.x, spot.z, 0.6, 2), name).toBeCloseTo(0, 3);
      expect(world.capsuleFits(new Vector3(spot.x, 0.03, spot.z), BODY_RADIUS + 0.35, BODY_HEIGHT), name).toBe(true);
    }
  });

  it('starts the west team in the walled yard, out of sight of the terraces and the east half', () => {
    const watchers = stands.filter((s) => s.raised || s.eye.x > -30);
    for (const spot of PLAYER_SPAWNS) {
      expect(spot.x < -41 && Math.abs(spot.z) < 10, `(${spot.x}, ${spot.z})`).toBe(true);
      const head = new Vector3(spot.x, EYE, spot.z);
      const seenFrom = watchers.find((w) => world.lineOfSight(w.eye, head));
      expect(seenFrom?.eye.toArray().map((n) => Number(n.toFixed(1))), `(${spot.x}, ${spot.z}) is visible`).toBeUndefined();
    }
  });

  it('makes one enemy spawn the twin of the first player spawn and the farthest point from it', () => {
    const first = PLAYER_SPAWNS[0] as Spot;
    const twin = turnSpot(first);
    expect(ENEMY_SPAWNS[0]).toEqual(twin);
    const distance = (s: Spot): number => Math.hypot(s.x - first.x, s.z - first.z);
    const others = all.filter((s) => s !== ENEMY_SPAWNS[0]);
    for (const other of others) expect(distance(other), `(${other.x}, ${other.z})`).toBeLessThan(distance(twin) - 2);
  });

  it('spreads the enemy spawns over the east half and both flanks', () => {
    expect(ENEMY_SPAWNS.filter((s) => s.x > 0).length).toBeGreaterThanOrEqual(ENEMY_SPAWNS.length - 2);
    expect(ENEMY_SPAWNS.some((s) => s.z < -25)).toBe(true);
    expect(ENEMY_SPAWNS.some((s) => s.z > 25)).toBe(true);
    for (const spot of ENEMY_SPAWNS) expect(spot.x, `(${spot.x}, ${spot.z})`).toBeGreaterThan(-12);
  });
});

describe('headworks sight lines', () => {
  it('finds standing room on the ground, on both terraces and on the ramps', () => {
    expect(stands.length).toBeGreaterThan(900);
    expect(stands.filter((s) => s.raised && s.eye.x < 0).length).toBeGreaterThan(8);
    expect(stands.filter((s) => s.raised && s.eye.x > 0).length).toBeGreaterThan(8);
  });

  it(`has no clear line longer than ${SIGHT_CAP} m between any two standing places`, () => {
    let worst = 0;
    let pair = '';
    const long: string[] = [];
    const seen = new Set<string>();
    const report = Boolean(node?.env.HEADWORKS_REPORT);
    for (let i = 0; i < stands.length; i++) {
      const a = (stands[i] as Stand).eye;
      for (let j = i + 1; j < stands.length; j++) {
        const b = (stands[j] as Stand).eye;
        const distance = a.distanceTo(b);
        if (distance <= (report ? SIGHT_CAP : Math.max(worst, SIGHT_CAP - 6)) || !world.lineOfSight(a, b)) continue;
        const text = `${distance.toFixed(1)} m from (${a.x.toFixed(1)}, ${a.y.toFixed(1)}, ${a.z.toFixed(1)}) to (${b.x.toFixed(1)}, ${b.y.toFixed(1)}, ${b.z.toFixed(1)})`;
        // One line per pair of 8 m neighbourhoods, so the report lists distinct views rather than every sample.
        const key = [a.x, a.z, b.x, b.z].map((n) => Math.round(n / 8)).join(',');
        if (distance > SIGHT_CAP && !seen.has(key)) {
          seen.add(key);
          long.push(text);
        }
        if (distance > worst) {
          worst = distance;
          pair = text;
        }
      }
    }
    if (report) node?.stdout.write(`${planView()}\nlongest sight line: ${pair}\n${long.join('\n')}\n`);
    expect(worst, pair).toBeLessThanOrEqual(SIGHT_CAP);
  });
});
