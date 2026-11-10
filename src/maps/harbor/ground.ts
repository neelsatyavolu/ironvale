import * as THREE from 'three/webgpu';
import { archedPanel, archSurround } from './arch';
import type { Kit } from './facade';
import { projectUv, slopedQuad } from './kit';
import {
  ALLEY,
  BASIN_SOUTH,
  EAST,
  MOLE,
  QUAY_EDGE,
  QUAY_NORTH,
  RAMP,
  SEABED_Y,
  SLIPWAY,
  SQUARE,
  SQUARE_STAIR,
  STREET_NORTH,
  STREET_SOUTH,
  TERRACE_EDGE,
  TERRACE_NORTH,
  TERRACE_Y,
  WATER_STEPS,
  WEST,
} from './layout';

const RISER = 0.18;
const COBBLE_TILE = 1.9;
const STONE_TILE = 2.2;
const WAVE_WALL_TOP = 2.9;
/** Stretches of low sea wall along the quay edge: [x0, x1]. The gaps are jetties, steps and the slipway. */
export const SEA_WALL_RUNS: readonly (readonly [number, number])[] = [
  [-44.5, -28],
  [-22, -12],
  [8, 26],
  [31.5, 39.4],
  [47.6, EAST],
];

function plane(x0: number, x1: number, z0: number, z1: number, y: number, tile: number): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  projectUv(geometry, tile);
  return geometry;
}

/** Streets, quay, terrace, stairs, ramps, harbour walls and everything that bounds the level. */
export function addGround(kit: Kit): void {
  const { batch, colliders, mats } = kit;

  // Lower town: one cobbled sheet from the terrace wall to the quay edge.
  batch.add(mats.cobble, plane(WEST - 4, EAST + 4, TERRACE_EDGE, QUAY_EDGE - 0.6, 0, COBBLE_TILE));
  colliders.span(WEST - 4, EAST + 4, -2.5, 0, TERRACE_EDGE - 0.5, QUAY_EDGE, 'cobble');

  // Quay edge: coping stones over a rubble wall that drops into the basin.
  batch.span(mats.stoneLight, MOLE.x1, EAST, -0.24, 0, QUAY_EDGE - 0.6, QUAY_EDGE + 0.06, { tile: 1.2 });
  batch.span(mats.stone, MOLE.x1, EAST, SEABED_Y - 0.3, -0.24, QUAY_EDGE - 0.6, QUAY_EDGE, { tile: STONE_TILE });
  for (const [x0, x1] of SEA_WALL_RUNS) {
    batch.span(mats.stone, x0, x1, 0, 0.52, QUAY_EDGE - 0.52, QUAY_EDGE - 0.08, { tile: STONE_TILE });
    batch.span(mats.stoneLight, x0 - 0.04, x1 + 0.04, 0.52, 0.62, QUAY_EDGE - 0.57, QUAY_EDGE - 0.03, { tile: 1.2 });
    colliders.span(x0, x1, 0, 0.62, QUAY_EDGE - 0.55, QUAY_EDGE - 0.05, 'concrete');
  }

  // Upper terrace and the retaining wall that faces the square.
  batch.add(mats.cobble, plane(WEST - 4, EAST + 4, TERRACE_NORTH - 1, TERRACE_EDGE, TERRACE_Y, COBBLE_TILE));
  colliders.span(WEST - 4, EAST + 4, 0, TERRACE_Y, TERRACE_NORTH - 14, TERRACE_EDGE, 'cobble');
  batch.span(mats.stone, SQUARE.x0, SQUARE.x1, 0, TERRACE_Y, TERRACE_EDGE - 0.05, TERRACE_EDGE + 0.25, { tile: STONE_TILE });
  for (const [x0, x1] of [
    [SQUARE.x0, -SQUARE_STAIR.landingHalf],
    [SQUARE_STAIR.landingHalf, SQUARE.x1],
  ] as const) {
    batch.span(mats.stone, x0, x1, TERRACE_Y, TERRACE_Y + 0.95, TERRACE_EDGE - 0.05, TERRACE_EDGE + 0.3, { tile: STONE_TILE });
    batch.span(mats.stoneLight, x0, x1, TERRACE_Y + 0.95, TERRACE_Y + 1.05, TERRACE_EDGE - 0.1, TERRACE_EDGE + 0.35, { tile: 1.2 });
    colliders.span(x0, x1, TERRACE_Y, TERRACE_Y + 1.05, TERRACE_EDGE - 0.05, TERRACE_EDGE + 0.3, 'concrete');
  }

  addSquareStair(kit);
  addAlleySteps(kit);
  addRamp(kit);
  addHarbourWorks(kit);
  addEndWalls(kit);
}

/** Two flights against the retaining wall that meet on a landing at terrace level. */
function addSquareStair(kit: Kit): void {
  const { batch, colliders, mats } = kit;
  const z0 = TERRACE_EDGE + 0.25;
  const z1 = z0 + SQUARE_STAIR.depth;
  const half = SQUARE_STAIR.landingHalf;
  const steps = Math.round(TERRACE_Y / RISER);
  const run = steps * SQUARE_STAIR.tread;

  batch.span(mats.stone, -half, half, 0, TERRACE_Y - 0.1, z0, z1 + 0.28, { tile: STONE_TILE });
  batch.span(mats.stoneLight, -half, half, TERRACE_Y - 0.1, TERRACE_Y, z0, z1, { tile: 1.2 });
  batch.span(mats.stone, -half, half, TERRACE_Y - 0.1, TERRACE_Y + 0.95, z1, z1 + 0.28, { tile: STONE_TILE });
  batch.span(mats.stoneLight, -half - 0.03, half + 0.03, TERRACE_Y + 0.95, TERRACE_Y + 1.05, z1 - 0.04, z1 + 0.32, { tile: 1.2 });
  colliders.span(-half, half, 0, TERRACE_Y, z0 - 0.3, z1, 'concrete');
  colliders.span(-half, half, 0, TERRACE_Y + 1.05, z1, z1 + 0.28, 'concrete');

  for (const dir of [-1, 1] as const) {
    for (let i = 0; i < steps; i++) {
      // Step 0 is the lowest, furthest from the landing.
      const far = dir * (half + run - i * SQUARE_STAIR.tread);
      const near = dir * (half + run - (i + 1) * SQUARE_STAIR.tread);
      const top = (i + 1) * RISER;
      const xa = Math.min(far, near);
      const xb = Math.max(far, near);
      batch.span(mats.stoneLight, xa, xb, 0, top, z0, z1, { tile: 1.2 });
      batch.span(mats.stone, xa, xb, 0, top + 0.9, z1, z1 + 0.28, { tile: STONE_TILE });
      batch.span(mats.stoneLight, xa, xb, top + 0.9, top + 0.98, z1 - 0.04, z1 + 0.32, { tile: 1.2 });
      colliders.span(xa, xb, 0, top + 0.98, z1, z1 + 0.28, 'concrete');
    }
    const foot = dir * (half + run);
    const head = dir * half;
    colliders.quad(
      [
        [foot, 0, z0],
        [foot, 0, z1],
        [head, TERRACE_Y, z1],
        [head, TERRACE_Y, z0],
      ],
      'concrete',
    );
  }
}

/** Narrow stepped alley from the main street up to the terrace. */
function addAlleySteps(kit: Kit): void {
  const { batch, colliders, mats } = kit;
  const steps = ALLEY.risers;
  const top = ALLEY.stepsFromZ - steps * ALLEY.tread;
  for (let i = 0; i < steps; i++) {
    const zs = ALLEY.stepsFromZ - (i + 1) * ALLEY.tread;
    batch.span(mats.stoneLight, ALLEY.x0, ALLEY.x1, 0, (i + 1) * RISER, zs, zs + ALLEY.tread, { tile: 1.2 });
  }
  batch.span(mats.cobble, ALLEY.x0, ALLEY.x1, 0, TERRACE_Y, TERRACE_EDGE, top, { tile: COBBLE_TILE });
  colliders.span(ALLEY.x0, ALLEY.x1, 0, TERRACE_Y, TERRACE_EDGE - 0.2, top, 'cobble');
  colliders.quad(
    [
      [ALLEY.x0, 0, ALLEY.stepsFromZ],
      [ALLEY.x1, 0, ALLEY.stepsFromZ],
      [ALLEY.x1, TERRACE_Y, top],
      [ALLEY.x0, TERRACE_Y, top],
    ],
    'concrete',
  );
}

/** Cobbled ramp on the east side. */
function addRamp(kit: Kit): void {
  const { batch, colliders, mats } = kit;
  const corners: [number, number, number][] = [
    [RAMP.x0, 0, RAMP.z1],
    [RAMP.x1, 0, RAMP.z1],
    [RAMP.x1, TERRACE_Y, RAMP.z0],
    [RAMP.x0, TERRACE_Y, RAMP.z0],
  ];
  batch.add(mats.cobble, slopedQuad(corners, COBBLE_TILE));
  colliders.quad(corners, 'cobble');
  // Drainage kerb down each side keeps it from reading as a flat sheet.
  const length = Math.hypot(RAMP.z1 - RAMP.z0, TERRACE_Y);
  const pitch = Math.atan2(TERRACE_Y, RAMP.z1 - RAMP.z0);
  for (const x of [RAMP.x0 + 0.14, RAMP.x1 - 0.14]) {
    batch.box(mats.stoneLight, 0.28, 0.16, length, x, TERRACE_Y / 2 + 0.03, (RAMP.z0 + RAMP.z1) / 2, { pitch, tile: 1.2 });
  }
}

/** Mole, wave walls, slipway, water steps and the basin floor. */
function addHarbourWorks(kit: Kit): void {
  const { batch, colliders, mats } = kit;
  const bed = SEABED_Y - 0.3;

  // West mole: a stone arm you can walk out on.
  batch.span(mats.stone, MOLE.x0, MOLE.x1, bed, -0.24, QUAY_EDGE - 0.6, MOLE.z1, { tile: STONE_TILE });
  batch.span(mats.stoneLight, MOLE.x0, MOLE.x1 + 0.06, -0.24, 0, QUAY_EDGE - 0.6, MOLE.z1 + 0.06, { tile: 1.2 });
  colliders.span(MOLE.x0, MOLE.x1, -2.5, 0, QUAY_EDGE, MOLE.z1, 'concrete');

  // Wave walls close the west and east sides from the quay out past the basin.
  for (const [x0, x1] of [
    [WEST - 0.8, WEST],
    [EAST, EAST + 0.8],
  ] as const) {
    batch.span(mats.stone, x0, x1, bed, WAVE_WALL_TOP, QUAY_NORTH, BASIN_SOUTH + 0.5, { tile: STONE_TILE });
    batch.span(mats.stoneLight, x0 - 0.06, x1 + 0.06, WAVE_WALL_TOP, WAVE_WALL_TOP + 0.14, QUAY_NORTH, BASIN_SOUTH + 0.56, { tile: 1.2 });
    colliders.span(x0, x1, -2.5, WAVE_WALL_TOP + 0.14, QUAY_NORTH, BASIN_SOUTH + 0.5, 'concrete');
  }

  // Slipway into the water.
  const slip: [number, number, number][] = [
    [SLIPWAY.x0, 0, QUAY_EDGE],
    [SLIPWAY.x1, 0, QUAY_EDGE],
    [SLIPWAY.x1, SEABED_Y - 0.1, SLIPWAY.z1],
    [SLIPWAY.x0, SEABED_Y - 0.1, SLIPWAY.z1],
  ];
  batch.add(mats.cobble, slopedQuad(slip, COBBLE_TILE));
  colliders.quad(slip, 'cobble');
  const slipLength = Math.hypot(SLIPWAY.z1 - QUAY_EDGE, SEABED_Y - 0.1);
  const slipPitch = -Math.atan2(SEABED_Y - 0.1, SLIPWAY.z1 - QUAY_EDGE);
  for (const x of [SLIPWAY.x0 - 0.2, SLIPWAY.x1 + 0.2]) {
    batch.box(mats.stone, 0.4, 1.3, slipLength, x, (SEABED_Y - 0.1) / 2 - 0.55, (QUAY_EDGE + SLIPWAY.z1) / 2, { pitch: slipPitch, tile: STONE_TILE });
  }

  // Stone steps down to the water beside the middle jetty.
  const z0 = QUAY_EDGE;
  const z1 = QUAY_EDGE + WATER_STEPS.depth;
  const tread = 0.42;
  const count = 8;
  batch.span(mats.stoneLight, WATER_STEPS.x1, WATER_STEPS.x1 + 1.2, bed, 0, z0, z1, { tile: 1.2 });
  colliders.span(WATER_STEPS.x1, WATER_STEPS.x1 + 1.2, -2.5, 0, z0, z1, 'concrete');
  for (let i = 0; i < count; i++) {
    const xb = WATER_STEPS.x1 - i * tread;
    batch.span(mats.stoneLight, xb - tread, xb, bed, -(i + 1) * RISER, z0, z1, { tile: 1.2 });
  }
  const foot = WATER_STEPS.x1 - count * tread;
  colliders.quad(
    [
      [WATER_STEPS.x1, 0, z0],
      [WATER_STEPS.x1, 0, z1],
      [foot, -count * RISER, z1],
      [foot, -count * RISER, z0],
    ],
    'concrete',
  );
  batch.span(mats.stoneLight, WATER_STEPS.x0, foot, bed, -count * RISER, z0, z1, { tile: 1.2 });
  colliders.span(WATER_STEPS.x0, foot, -2.5, -count * RISER, z0, z1, 'concrete');

  // Basin floor (you wade, you do not swim) and an unseen kerb across the harbour mouth.
  colliders.span(WEST - 0.8, EAST + 0.8, SEABED_Y - 1, SEABED_Y, QUAY_EDGE, BASIN_SOUTH + 0.5, 'water');
  colliders.span(WEST - 0.8, EAST + 0.8, SEABED_Y, 0.4, BASIN_SOUTH, BASIN_SOUTH + 0.5, 'water');
}

/** Town walls with shut gates that close the street and terrace at each end. */
function addEndWalls(kit: Kit): void {
  const { batch, colliders, mats } = kit;
  const gate = archedPanel(2.9, 2.3, 1.2);
  const surround = archSurround(2.9, 2.3, 1.2, 0.32, 0.14);
  const gateDoor = mats.paint[2]!;

  for (const [x, facing] of [
    [WEST, 1],
    [EAST, -1],
  ] as const) {
    const outer = x - facing * 0.7;
    const xa = Math.min(x, outer);
    const xb = Math.max(x, outer);
    // Street gate.
    batch.span(mats.stone, xa, xb, 0, 5.2, STREET_NORTH, STREET_SOUTH, { tile: STONE_TILE });
    batch.span(mats.stoneLight, xa - 0.08, xb + 0.08, 5.2, 5.36, STREET_NORTH, STREET_SOUTH, { tile: 1.2 });
    colliders.span(xa, xb, 0, 5.36, STREET_NORTH, STREET_SOUTH, 'concrete');
    const zc = (STREET_NORTH + STREET_SOUTH) / 2;
    const yaw = (facing * Math.PI) / 2;
    batch.place(gateDoor, gate, x + facing * 0.02, 0, zc, yaw, 1, 1);
    batch.place(mats.stoneLight, surround, x + facing * 0.0, 0, zc, yaw, 1, 1.2);
    // Terrace gate.
    batch.span(mats.stone, xa, xb, TERRACE_Y, TERRACE_Y + 4.4, TERRACE_NORTH, TERRACE_EDGE, { tile: STONE_TILE });
    batch.span(mats.stoneLight, xa - 0.08, xb + 0.08, TERRACE_Y + 4.4, TERRACE_Y + 4.56, TERRACE_NORTH, TERRACE_EDGE, { tile: 1.2 });
    colliders.span(xa, xb, TERRACE_Y, TERRACE_Y + 4.56, TERRACE_NORTH, TERRACE_EDGE, 'concrete');
    const zt = (TERRACE_NORTH + TERRACE_EDGE) / 2;
    batch.place(mats.paint[1]!, gate, x + facing * 0.02, TERRACE_Y, zt, yaw, 0.85, 1);
    batch.place(mats.stoneLight, surround, x, TERRACE_Y, zt, yaw, 0.85, 1.2);
  }
}
