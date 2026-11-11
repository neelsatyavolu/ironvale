/**
 * Railyard ground plan as plain data: where the edges, buildings, container
 * stacks and spawns are. No rendering here, so tests can check it.
 *
 * Axes: +X east, +Z south. Players start at the south gate and push north to
 * the quay, with the low sun ahead of them over the water.
 */

export const CONTAINER = { length20: 6.058, length40: 12.192, width: 2.438, height: 2.591 } as const;

/** Edges of the walkable yard. */
export const YARD = {
  west: -42,
  east: 42,
  south: 50,
  /** Where the asphalt gives way to the concrete quay apron. */
  apron: -30,
  /** Quay edge; water beyond. */
  quay: -46,
} as const;

export const WAREHOUSE = {
  west: -42,
  east: -18,
  north: -24,
  south: 20,
  eaves: 7.6,
  ridge: 10.6,
  /** Column spacing along the long sides. */
  bay: 5.5,
  /** Cargo doors in both gables. */
  door: { west: -34, east: -26, height: 5.4 },
  mezzanine: { west: -42, east: -35.5, north: -8.5, south: 16, top: 3.06 },
} as const;

export const OFFICE = { west: 35.2, east: 41.2, north: 9, south: 18.5, height: 2.75 } as const;

/**
 * Personnel doors, 0.95 m wide (west and east jambs). The bots path on a 0.6 m
 * grid measured from BOUNDS.min, and a soldier is 0.68 m across, so each door
 * is centred on a grid column: otherwise no cell lines up with the opening.
 */
export const DOORS = {
  office: { west: 36.625, east: 37.575 },
  staff: { west: -21.575, east: -20.625 },
} as const;

/** Centre lines of the two tracks and the ballast bed they sit on. */
export const RAIL = { trackA: 24.6, trackB: 29.4, bedWest: 21.6, bedEast: 32.4, north: -30, south: 47 } as const;

/** Parked skeletal trailer carrying a 40 ft box, on the way from the gate to the shed. `deck` is where the container sits. */
export const TRAILER = { x: -24, z: 41.5, yaw: Math.PI / 2 + 0.07, deck: 1.3 } as const;

export const BOUNDS = { min: [-43, -1, -47], max: [43, 14, 50.5] } as const;

/** Paint colours for containers. The last two are light, so lettering on them is dark. */
export const LIVERIES = [0x6a372c, 0x22384f, 0x2b504a, 0x77623f, 0x5a2f33, 0x33485c, 0x444c3b, 0x744a34, 0x787d81, 0xa3a29a] as const;
export const LIGHT_LIVERY_FROM = 8;

export interface ContainerSpot {
  readonly x: number;
  readonly z: number;
  /** Underside height. */
  readonly y: number;
  /** 0 puts the long axis on Z with doors facing south. */
  readonly yaw: number;
  readonly long: boolean;
  readonly livery: number;
  /** Carries a shipping-line name on its sides. */
  readonly lettered: boolean;
  /** Scenery beyond the fence: no collider, and thinned out at low detail. */
  readonly backdrop: boolean;
  /** true for the bottom container of a stack, which carries the stack's collider. */
  readonly stackBase: boolean;
  /** Containers in the stack this one belongs to. */
  readonly stackLevels: number;
}

interface StackOptions {
  readonly yaw?: number;
  readonly long?: boolean;
  readonly backdrop?: boolean;
  readonly y?: number;
  /** Leave out this many containers at the bottom, where a wall or a nearer stack hides them. */
  readonly hidden?: number;
}

const END_GAP = 0.22;

/** Every container in the map. Deterministic for a given random source. */
export function planContainers(random: () => number): ContainerSpot[] {
  const spots: ContainerSpot[] = [];

  const stack = (x: number, z: number, levels: number, options: StackOptions = {}): void => {
    const flip = random() < 0.5 ? Math.PI : 0;
    const first = options.hidden ?? 0;
    for (let level = first; level < levels; level++) {
      spots.push({
        x,
        z,
        y: (options.y ?? 0) + level * CONTAINER.height,
        yaw: (options.yaw ?? 0) + flip,
        long: options.long ?? false,
        livery: Math.floor(random() * LIVERIES.length),
        lettered: random() < 0.45,
        backdrop: options.backdrop ?? false,
        stackBase: level === first,
        stackLevels: levels,
      });
    }
  };

  /**
   * A line of stacks running south from `north`. Tokens: `2` a 20 ft stack two
   * high, `L2` a 40 ft stack, `g5.5` a 5.5 m gap (a cross lane), `_` one empty
   * 20 ft slot.
   */
  const row = (x: number, north: number, pattern: string): void => {
    let z = north;
    for (const token of pattern.split(' ')) {
      if (token.startsWith('g')) {
        z += Number(token.slice(1));
      } else if (token === '_') {
        z += CONTAINER.length20 + END_GAP;
      } else {
        const long = token.startsWith('L');
        const length = long ? CONTAINER.length40 : CONTAINER.length20;
        stack(x, z + length / 2, Number(long ? token.slice(1) : token), { long });
        z += length + END_GAP;
      }
    }
  };

  // The stacking block between the warehouse road and the tracks. Four rows,
  // cross lanes staggered so no east-west run is straight.
  row(-10.5, -28, '2 1 2 g5.5 1 2 2 g5.3 L2');
  row(-3.3, -28, '2 2 1 g5.5 2 _ 2 g5.3 L1');
  row(-0.8, -28, '1 2 2 g5.5 2 2 1 g5.3 L2');
  row(8.8, -28, 'L2 g5 2 1 2 g5.5 2 2 1');
  row(15.5, -28, '2 2 g5 1 2 L2 g5.5 2 1');

  // Singles that close lanes or give cover in the open.
  stack(12.15, 34.2, 1, { yaw: Math.PI / 2 }); // closes the south end of the east lane
  stack(-14, -38, 1, { yaw: 1.22 });
  stack(11.6, -39, 2, { yaw: Math.PI / 2 });
  stack(36.4, -36.5, 2, { yaw: Math.PI / 2 });
  stack(39.9, -19, 2);
  stack(39.9, -12.6, 1);
  stack(39.2, 30, 1, { yaw: 0.06 });
  stack(TRAILER.x, TRAILER.z, 1, { yaw: TRAILER.yaw, long: true, y: TRAILER.deck }); // on the parked trailer
  stack(-36.5, 28, 2);
  stack(-38.4, 47.2, 1, { yaw: Math.PI / 2 });

  // Cargo on the flat wagon, and the box hanging from the yard gantry (no collider: it is 9 m up).
  stack(RAIL.trackA, -11.4, 1, { y: 1.2 });
  spots.push({ x: 4, z: 6, y: 9.2, yaw: 0, long: false, livery: 3, lettered: true, backdrop: false, stackBase: false, stackLevels: 1 });

  // Scenery beyond the fence and walls.
  const slot = CONTAINER.length20 + END_GAP;
  for (let z = -43; z < 48; z += slot) {
    stack(45.3, z, 2 + Math.floor(random() * 2), { backdrop: true });
    stack(48.1, z + 1.4, 3 + Math.floor(random() * 2), { backdrop: true, hidden: 2 });
  }
  for (let x = -40; x < 42; x += slot) {
    stack(x, 53.2, 2 + Math.floor(random() * 2), { yaw: Math.PI / 2, backdrop: true, hidden: 1 });
  }
  for (let z = 23.5; z < 49; z += slot) stack(-45.4, z, 2 + Math.floor(random() * 2), { backdrop: true, hidden: 1 });
  for (let z = -43; z < -26; z += slot) stack(-45.4, z, 3, { backdrop: true, hidden: 1 });
  // Deck cargo on the ship.
  for (let x = 46; x < 96; x += slot) {
    stack(x, -56.2, 2 + Math.floor(random() * 2), { yaw: Math.PI / 2, backdrop: true, y: SHIP.deck });
    stack(x, -58.9, 3, { yaw: Math.PI / 2, backdrop: true, y: SHIP.deck });
  }
  return spots;
}

/** Moored container ship off the north-east corner. The bow points west. */
export const SHIP = { bow: 33, stern: 128, near: -52.5, far: -78, deck: 10.6, waterline: -2.4 } as const;

export interface SpawnSpot {
  readonly x: number;
  readonly z: number;
  /** Degrees; 0 looks north (down -Z). */
  readonly yaw: number;
}

/**
 * Either side of the gate, in the shadow of the row ends: nobody at the far
 * end of the avenue or a lane can see a soldier appear here.
 */
export const PLAYER_SPAWNS: readonly SpawnSpot[] = [
  { x: -3, z: 45.5, yaw: 0 },
  { x: -1.9, z: 47.3, yaw: 0 },
  { x: 9.8, z: 45.5, yaw: 0 },
  { x: 12.2, z: 46.8, yaw: 0 },
];

export const ENEMY_SPAWNS: readonly SpawnSpot[] = [
  // Quay apron.
  { x: -31, z: -38, yaw: 180 },
  { x: -9, z: -41, yaw: 180 },
  { x: 4, z: -36, yaw: 180 },
  { x: 20, z: -40, yaw: 180 },
  { x: 37, z: -41, yaw: 180 },
  // North half of the warehouse.
  { x: -30, z: -17, yaw: 180 },
  { x: -21.5, z: -7, yaw: 180 },
  // Container lanes.
  { x: -7, z: -20, yaw: 180 },
  { x: 12.2, z: -19, yaw: 180 },
  { x: 4, z: -22, yaw: 180 },
  // Tracks and the east strip.
  { x: 26.4, z: -26, yaw: 180 },
  { x: 36.5, z: -6, yaw: 180 },
  // Flanks at mid-map.
  { x: -15.8, z: -3, yaw: 180 },
  { x: 19.6, z: -14, yaw: 180 },
];
