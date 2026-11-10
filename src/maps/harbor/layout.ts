/**
 * Harbor layout constants. X runs west (-) to east (+), Z runs north (-) to
 * south (+). The sea is to the south, the town climbs to a terrace in the north.
 *
 *   z -36 .. -22   north row of houses and the church (backdrop, terrace level)
 *   z -22 .. -16   upper terrace street (y = TERRACE_Y)
 *   z -16 ..  -4   second row of houses, split by the square, the stepped alley and the east ramp
 *   z  -4 ..   2   main street
 *   z   2 ..  10   front row of houses (net store, cafe, arched passage)
 *   z  10 ..  20   cobbled quay
 *   z  20 ..  48   harbour basin with three jetties
 */

/** Seventeen 0.18 m risers. */
export const TERRACE_Y = 3.06;
export const STOREY = 3;
export const WATER_Y = -0.85;
export const SEABED_Y = -1.5;

export const WEST = -52;
export const EAST = 52;
export const QUAY_EDGE = 20;
export const QUAY_NORTH = 10;
export const STREET_SOUTH = 2;
export const STREET_NORTH = -4;
export const TERRACE_EDGE = -16;
export const TERRACE_NORTH = -22;
export const BASIN_SOUTH = 48;

export const SQUARE = { x0: -12, x1: 12, z0: TERRACE_EDGE, z1: STREET_SOUTH } as const;
export const FOUNTAIN = { x: 0, z: -6.5 } as const;

/** Stepped alley between the second-row houses on the west side. */
export const ALLEY = { x0: -32, x1: -29.5, stepsFromZ: -6.6, tread: 0.34, risers: 17 } as const;
/** Cobbled ramp up to the terrace on the east side. */
export const RAMP = { x0: 30, x1: 34, z0: -16, z1: -5 } as const;
/** Double stair against the retaining wall on the north side of the square. */
export const SQUARE_STAIR = { depth: 1.7, tread: 0.34, landingHalf: 2.2 } as const;

/** Vaulted passage through the front row, square to quay. */
export const PASSAGE = { x0: 7.5, x1: 11 } as const;
export const NET_STORE = { x0: -35.5, x1: -25, z0: STREET_SOUTH, z1: QUAY_NORTH } as const;
export const CAFE = { x0: -12, x1: 3, z0: STREET_SOUTH, z1: QUAY_NORTH } as const;

export interface Jetty {
  readonly x: number;
  readonly width: number;
  readonly length: number;
  /** Half-width of a T-head at the seaward end, 0 for none. */
  readonly head: number;
}
export const JETTIES: readonly Jetty[] = [
  { x: -26, width: 2.4, length: 16, head: 0 },
  { x: 3, width: 2.8, length: 18, head: 6 },
  { x: 29, width: 2.4, length: 14, head: 0 },
];
export const MOLE = { x0: WEST, x1: -45.5, z1: 42 } as const;
export const SLIPWAY = { x0: 40, x1: 47, z1: 33 } as const;
/** Stone steps from the quay down into the basin. */
export const WATER_STEPS = { x0: -10.2, x1: -6, depth: 1.5 } as const;

export const BOUNDS = { minX: -53, maxX: 53, minY: -3, maxY: 30, minZ: -23, maxZ: 49 } as const;

export interface SpawnSpec {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

const FACE_EAST = -Math.PI / 2;
const FACE_WEST = Math.PI / 2;
const LOW = 0.05;
const HIGH = TERRACE_Y + 0.05;

/**
 * Players start at the east end by the slipway and push west, into the low sun.
 * A stack of cases in the street and a laid-up boat on the quay stand between
 * them and the long views from the far end.
 */
export const PLAYER_SPAWNS: readonly SpawnSpec[] = [
  { x: 47.5, y: LOW, z: -1.4, yaw: FACE_WEST },
  { x: 45, y: LOW, z: -0.4, yaw: FACE_WEST },
  { x: 48.5, y: LOW, z: 13.2, yaw: FACE_WEST },
  { x: 46, y: LOW, z: 16.4, yaw: FACE_WEST },
];

export const ENEMY_SPAWNS: readonly SpawnSpec[] = [
  { x: -47, y: LOW, z: 15, yaw: FACE_EAST },
  { x: -43, y: LOW, z: 14, yaw: FACE_EAST },
  { x: -48, y: LOW, z: -1, yaw: FACE_EAST },
  { x: -42.5, y: LOW, z: 0.6, yaw: FACE_EAST },
  { x: -25, y: LOW, z: -1.6, yaw: FACE_EAST },
  { x: -36.75, y: LOW, z: 6, yaw: Math.PI },
  { x: -46, y: HIGH, z: -19, yaw: FACE_EAST },
  { x: -24, y: HIGH, z: -19.5, yaw: FACE_EAST },
  { x: -5, y: HIGH, z: -19, yaw: Math.PI },
  { x: -5.2, y: LOW, z: -9.4, yaw: FACE_EAST },
  { x: -26, y: LOW, z: 30, yaw: 0 },
  { x: -48.6, y: LOW, z: 33, yaw: 0 },
  { x: -29.2, y: LOW, z: 7.3, yaw: FACE_EAST },
  { x: 15, y: HIGH, z: -19, yaw: FACE_WEST },
];
