/**
 * Headworks layout as plain data: every solid that stops a body or a bullet,
 * the ramps, the spawns and the roofed zones. West is -X, north is -Z.
 *
 * The level is point-symmetric about the origin: `HALF_*` lists describe the
 * pieces that belong to the west side, and each has a twin turned 180 degrees
 * for the east side. Colliders, tests and the visible level are all built
 * from these lists, so they cannot drift apart.
 */

/** What a block is, which decides how it is drawn. Collision treats them all alike. */
export type BlockRole =
  | 'perimeter'
  | 'building'
  | 'wall'
  | 'basin'
  | 'gallery'
  | 'house'
  | 'roof'
  | 'deck'
  | 'parapet'
  | 'plinth'
  | 'kiosk'
  | 'cabinet'
  | 'pumpset'
  | 'manifold'
  | 'barrier'
  | 'pipes';

export interface Block {
  readonly id: string;
  readonly role: BlockRole;
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
  /** Underside. */
  readonly y: number;
  readonly h: number;
}

export interface Drum {
  readonly id: string;
  readonly role: 'clarifier' | 'silo';
  readonly x: number;
  readonly z: number;
  readonly r: number;
  readonly h: number;
}

/** Straight ramp from its foot on the ground to its top on a deck. */
export interface Ramp {
  readonly id: string;
  readonly footX: number;
  readonly footZ: number;
  readonly topX: number;
  readonly topZ: number;
  readonly rise: number;
  readonly width: number;
}

/** Handrail along a drop, from a to b at floor level. Stops bodies, not bullets. */
export interface Rail {
  readonly id: string;
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
}

export interface Spot {
  readonly x: number;
  readonly z: number;
  /** Degrees; 0 looks north (-Z), 90 looks west. */
  readonly yaw: number;
}

export interface Zone {
  readonly id: string;
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
  readonly height: number;
}

/** Inner faces of the perimeter wall; the playable area. */
export const HALF_X = 47;
export const HALF_Z = 41;
export const BOUNDS = { min: [-HALF_X, -1, -HALF_Z], max: [HALF_X, 12, HALF_Z] } as const;

export const DECK_HEIGHT = 2.4;
export const WALL_HEIGHT = 4.4;
/** Crouch cover and the least height that hides a standing soldier. Nothing sits between them. */
export const COVER_LOW = 1.2;
export const COVER_HIGH = 1.7;
export const TANK = { x: -11, z: -5, radius: 9.5, height: 4.6 } as const;
/** Pump house on the west side (outer faces). Its south wall is the perimeter wall. */
export const HOUSE = { x0: -28, x1: -12, z0: 27, z1: HALF_Z, wall: 0.4, height: 4.6, door: 2.5 } as const;
/** Service terrace on the west side. */
/**
 * Service bridge from one clarifier to the other, over the slot between them.
 * Scenery: nobody can reach it. Its deep girder also closes the view from one
 * terrace to the other.
 */
export const BRIDGE = {
  length: 2 * Math.hypot(TANK.x, TANK.z),
  width: 2.6,
  underside: 3.2,
  depth: 2.8,
  /** Turn about Y that lays a box's X axis along the line between the tank centres. */
  yaw: -Math.atan2(TANK.z, TANK.x),
} as const;
export const TERRACE = { x0: -20, x1: -8, z0: 15, z1: 20 } as const;

const block = (id: string, role: BlockRole, x0: number, x1: number, z0: number, z1: number, h: number, y = 0): Block => ({
  id,
  role,
  x0,
  x1,
  z0,
  z1,
  y,
  h,
});

const H = HOUSE;
const T = TERRACE;
const RAIL = DECK_HEIGHT + 2;

/** Blocks of the west side. */
const HALF_BLOCKS: readonly Block[] = [
  // Control building and the walled yard behind it where the west team starts.
  block('control', 'building', -41, -34, -10, 10, 6.5),
  block('yard-n', 'wall', -HALF_X, -44, -10.5, -10, 3.2),
  block('yard-s', 'wall', -HALF_X, -44, 10, 10.5, 3.2),
  block('screen-n', 'wall', -HALF_X, -38.5, -14, -13.5, 3.2),
  block('screen-s', 'wall', -HALF_X, -38.5, 13.5, 14, 3.2),

  // North lane, west part: the Filter Walk road, its basins and the two walls that stagger it.
  block('beds', 'basin', -34, 0, -HALF_Z, -35, 2.2),
  block('stagger-a', 'basin', -5, 0, -35, -29, 3.2),
  block('stagger-b', 'basin', -13, -9, -31, -23, 3.2),
  block('gallery', 'gallery', -23, -4.5, -23, -19, WALL_HEIGHT),
  block('store', 'building', -38.5, -27, -23, -19, WALL_HEIGHT),
  block('walk-plinth-1', 'plinth', -39, -37, -31.5, -30, COVER_LOW),
  block('walk-kiosk', 'kiosk', -27.8, -21.6, -27.5, -25.5, 2.1),
  block('walk-plinth-2', 'plinth', -22.5, -20.5, -33, -31.5, COVER_LOW),
  block('walk-plinth-3', 'plinth', -17, -15, -27, -25.5, COVER_LOW),
  block('nw-dosing', 'kiosk', -44, -41, -25, -21, 2.3),

  // West court, between the control building and the clarifier.
  block('court-manifold', 'manifold', -29, -23.5, -3.5, -0.5, 2.9),
  block('court-panel', 'cabinet', -30, -25.6, -12.2, -11.2, 2),
  block('court-low-s', 'barrier', -31.5, -30.3, 5, 7.4, COVER_LOW),
  block('court-cabinet', 'cabinet', -23.4, -22.4, 4, 8.8, 2),
  block('passage-low', 'barrier', -9, -6.6, -18.2, -17, COVER_LOW),
  // Walls from the clarifier to the lane buildings close the court; each has one door, set off from the next gap.
  block('court-wall-n1', 'wall', -20.4, -20, -19, -15.5, WALL_HEIGHT),
  block('court-wall-n2', 'wall', -20.4, -20, -12.5, -7, WALL_HEIGHT),
  block('court-wall-s1', 'wall', -20.4, -20, -3, 4.5, WALL_HEIGHT),
  block('court-wall-s2', 'wall', -20.4, -20, 8, T.z0, WALL_HEIGHT),
  block('court-wall-n-lintel', 'wall', -20.4, -20, -15.5, -12.5, WALL_HEIGHT - 2.5, 2.5),
  block('court-wall-s-lintel', 'wall', -20.4, -20, 4.5, 8, WALL_HEIGHT - 2.5, 2.5),
  block('centre-kiosk', 'kiosk', -3.4, 0.4, -16, -14, 2.1),
  block('passage-baffle', 'wall', -17, -16.4, -16.5, -12.4, WALL_HEIGHT),

  // Terrace over the south court: podium, rear and end walls, parapet with a low middle.
  block('deck', 'deck', T.x0, T.x1, T.z0, T.z1, DECK_HEIGHT),
  block('landing', 'deck', -11, T.x1, T.z1, 23.6, DECK_HEIGHT),
  block('deck-rear', 'wall', T.x0, -11, T.z1, T.z1 + 0.6, RAIL),
  block('deck-west', 'wall', T.x0 - 0.4, T.x0, T.z0, 17, RAIL),
  block('deck-east', 'wall', T.x1, T.x1 + 0.4, T.z0, T.z1, RAIL),
  block('parapet-w', 'parapet', T.x0, -16.5, T.z0, T.z0 + 0.4, 2, DECK_HEIGHT),
  block('parapet-mid', 'parapet', -16.5, -12, T.z0, T.z0 + 0.4, COVER_LOW, DECK_HEIGHT),
  block('parapet-e', 'parapet', -12, T.x1, T.z0, T.z0 + 0.4, 2, DECK_HEIGHT),
  block('ramp-wing', 'wall', -23, T.x0 - 0.4, 16.6, 17, RAIL),
  block('ramp-wall', 'wall', -30, T.x0, T.z1, T.z1 + 0.6, WALL_HEIGHT),
  block('centre-wall', 'wall', T.x1, 0, T.z1, T.z1 + 0.6, WALL_HEIGHT),

  // South court under the terrace.
  block('south-cabinet', 'cabinet', -19, -8, 11, 12, 2.2),
  block('south-manifold', 'manifold', -5.6, -3.6, 10, 14, 2),

  // Pump house: walls with three doors, lintels, roof and the machinery inside.
  block('house-n-w', 'house', H.x0, -22, H.z0, H.z0 + H.wall, H.height),
  block('house-n-e', 'house', -22 + H.door, H.x1, H.z0, H.z0 + H.wall, H.height),
  block('house-n-lintel', 'house', -22, -22 + H.door, H.z0, H.z0 + H.wall, H.height - 2.5, 2.5),
  block('house-w-n', 'house', H.x0, H.x0 + H.wall, H.z0, 31, H.height),
  block('house-w-s', 'house', H.x0, H.x0 + H.wall, 31 + H.door, H.z1, H.height),
  block('house-w-lintel', 'house', H.x0, H.x0 + H.wall, 31, 31 + H.door, H.height - 2.5, 2.5),
  block('house-e-n', 'house', H.x1 - H.wall, H.x1, H.z0, 34.5, H.height),
  block('house-e-s', 'house', H.x1 - H.wall, H.x1, 34.5 + H.door, H.z1, H.height),
  block('house-e-lintel', 'house', H.x1 - H.wall, H.x1, 34.5, 34.5 + H.door, H.height - 2.5, 2.5),
  block('house-roof', 'roof', H.x0 - 0.3, H.x1 + 0.3, H.z0 - 0.3, H.z1, 0.35, H.height),
  block('pump-1', 'pumpset', -25.2, -21.6, 35.2, 37, 1.9),
  block('pump-2', 'pumpset', -18.6, -15, 33.6, 35.6, 1.9),
  block('mcc', 'cabinet', -20.5, -15.5, 30.6, 31.4, 2.1),
  block('house-low-1', 'barrier', -25, -22.8, 29.6, 30.8, COVER_LOW),
  block('house-low-2', 'barrier', -14.6, -13.4, 31.8, 33.6, COVER_LOW),

  // Alley north of the pump house, the maintenance court east of it and the south-west corner.
  block('alley-low', 'barrier', -19, -16.6, 25.6, 26.8, COVER_LOW),
  block('alley-kiosk', 'kiosk', -27, -24.6, 21.4, 23.8, 2.2),
  block('court-pipes', 'pipes', -6, -3.2, 23.6, 28.6, 2.2),
  block('court-low', 'barrier', -4, -1.6, 37.4, 38.6, COVER_LOW),
  block('sw-wall', 'wall', -39.5, -34, T.z1, T.z1 + 0.6, WALL_HEIGHT),
  block('sw-generator', 'kiosk', -35.6, -29.6, 23.4, 25.8, 2.4),
  block('sw-bund', 'barrier', -45.2, -39.2, 27.4, 27.8, COVER_LOW),
  block('sw-low', 'barrier', -33.6, -32.4, 33, 35.4, COVER_LOW),
];

const HALF_DRUMS: readonly Drum[] = [
  { id: 'clarifier', role: 'clarifier', x: TANK.x, z: TANK.z, r: TANK.radius, h: TANK.height },
  { id: 'silo-1', role: 'silo', x: -43.6, z: 31.4, r: 1.5, h: 4.2 },
  { id: 'silo-2', role: 'silo', x: -40.4, z: 31.4, r: 1.5, h: 4.2 },
];

const HALF_RAMPS: readonly Ramp[] = [
  { id: 'ramp-court', footX: -27.2, footZ: 18.5, topX: T.x0, topZ: 18.5, rise: DECK_HEIGHT, width: 3 },
  { id: 'ramp-lane', footX: -0.8, footZ: 22.1, topX: T.x1, topZ: 22.1, rise: DECK_HEIGHT, width: 3 },
];

/** Handrails at drops: the open side of each ramp and the edges of the landing. */
const HALF_RAILS: readonly Rail[] = [
  { id: 'rail-ramp-court', ax: -27.2, ay: 0, az: 17, bx: T.x0, by: DECK_HEIGHT, bz: 17 },
  { id: 'rail-landing-w', ax: -11, ay: DECK_HEIGHT, az: 20.6, bx: -11, by: DECK_HEIGHT, bz: 23.6 },
  { id: 'rail-landing-s', ax: -11, ay: DECK_HEIGHT, az: 23.6, bx: T.x1, by: DECK_HEIGHT, bz: 23.6 },
  { id: 'rail-ramp-lane', ax: T.x1, ay: DECK_HEIGHT, az: 23.6, bx: -0.8, by: 0, bz: 23.6 },
];

/** Pieces that are their own twin. */
const CENTRE_BLOCKS: readonly Block[] = [
  block('perimeter-n', 'perimeter', -HALF_X - 0.6, HALF_X + 0.6, -HALF_Z - 0.6, -HALF_Z, WALL_HEIGHT),
  block('perimeter-s', 'perimeter', -HALF_X - 0.6, HALF_X + 0.6, HALF_Z, HALF_Z + 0.6, WALL_HEIGHT),
  block('perimeter-w', 'perimeter', -HALF_X - 0.6, -HALF_X, -HALF_Z, HALF_Z, WALL_HEIGHT),
  block('perimeter-e', 'perimeter', HALF_X, HALF_X + 0.6, -HALF_Z, HALF_Z, WALL_HEIGHT),
];

const TWIN = '-east';

export const turnBlock = (b: Block): Block => ({ ...b, id: b.id + TWIN, x0: -b.x1, x1: -b.x0, z0: -b.z1, z1: -b.z0 });
export const turnDrum = (d: Drum): Drum => ({ ...d, id: d.id + TWIN, x: -d.x, z: -d.z });
export const turnRamp = (r: Ramp): Ramp => ({ ...r, id: r.id + TWIN, footX: -r.footX, footZ: -r.footZ, topX: -r.topX, topZ: -r.topZ });
export const turnRail = (r: Rail): Rail => ({ ...r, id: r.id + TWIN, ax: -r.ax, az: -r.az, bx: -r.bx, bz: -r.bz });
export const turnSpot =(s: Spot): Spot => ({ x: -s.x, z: -s.z, yaw: s.yaw + 180 });
export const turnZone = (z: Zone): Zone => ({ ...z, id: z.id + TWIN, x0: -z.x1, x1: -z.x0, z0: -z.z1, z1: -z.z0 });
/** true for the east-side copy of a west-side piece. Wear and props differ between the two. */
export const isTwin = (piece: { readonly id: string }): boolean => piece.id.endsWith(TWIN);

export const BLOCKS: readonly Block[] = [...CENTRE_BLOCKS, ...HALF_BLOCKS, ...HALF_BLOCKS.map(turnBlock)];
export const DRUMS: readonly Drum[] = [...HALF_DRUMS, ...HALF_DRUMS.map(turnDrum)];
export const RAMPS: readonly Ramp[] = [...HALF_RAMPS, ...HALF_RAMPS.map(turnRamp)];
export const RAILS: readonly Rail[] = [...HALF_RAILS, ...HALF_RAILS.map(turnRail)];

const HOUSE_ZONE: Zone = { id: 'pump-house', x0: H.x0, x1: H.x1, z0: H.z0, z1: H.z1, height: H.height };
export const HOUSES: readonly Zone[] = [HOUSE_ZONE, turnZone(HOUSE_ZONE)];

/** Footprints of the two terraces (deck and landing), for telling raised floor from rooftops. */
export const DECKS: readonly Block[] = BLOCKS.filter((b) => b.role === 'deck');

/** The west team starts in the walled yard behind the control building. */
export const PLAYER_SPAWNS: readonly Spot[] = [
  { x: -45.2, z: 0, yaw: 0 },
  { x: -43.6, z: -4.6, yaw: -90 },
  { x: -43.6, z: 4.6, yaw: -90 },
  { x: -45.6, z: -6.4, yaw: 0 },
  { x: -45.6, z: 6.4, yaw: 180 },
];

/**
 * The first is the twin of the first player spawn and the farthest point from
 * it, which is where a duel puts the guest. The rest are spread over the east
 * half and both flanks.
 */
export const ENEMY_SPAWNS: readonly Spot[] = [
  turnSpot(PLAYER_SPAWNS[0] as Spot),
  { x: 36, z: -32, yaw: 90 },
  { x: 37, z: 29, yaw: 90 },
  { x: 20, z: -38.5, yaw: 0 },
  { x: 31.5, z: 6.5, yaw: 90 },
  { x: 7, z: -36, yaw: 180 },
  { x: 26, z: 30, yaw: 90 },
  { x: -7, z: 37.6, yaw: 0 },
  { x: 30, z: -12.5, yaw: 90 },
];
