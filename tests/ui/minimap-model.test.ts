import { describe, expect, it } from 'vitest';
import {
  buildLayout,
  CELL_FLOOR,
  CELL_SOLID,
  CELL_WALL,
  horizontalHalfFov,
  shotAge,
  toMap,
  type MapPoint,
  type NavSource,
} from '../../src/ui/hud/minimap-model';

/** A grid from rows of text: `.` one walkable node, `#` no node, `x` a node nobody can reach, `2` two floors. */
function source(rows: readonly string[]): NavSource {
  const nx = rows[0]!.length;
  const nz = rows.length;
  const colStart = new Int32Array(nx * nz + 1);
  const edges: number[] = [];
  rows.forEach((row, iz) => {
    [...row].forEach((char, ix) => {
      colStart[iz * nx + ix] = edges.length;
      if (char === '.') edges.push(0xff);
      else if (char === 'x') edges.push(0);
      else if (char === '2') edges.push(0, 0x11);
    });
  });
  colStart[nx * nz] = edges.length;
  return { nx, nz, originX: -3, originZ: 12, cell: 0.6, colStart, edges: Uint8Array.from(edges) };
}

function picture(rows: readonly string[], rim?: number): string[] {
  const layout = buildLayout(source(rows), rim);
  const names = { [CELL_FLOOR]: '.', [CELL_WALL]: 'W', [CELL_SOLID]: 'S' } as Record<number, string>;
  return rows.map((_, iz) => [...layout.cells.subarray(iz * layout.nx, (iz + 1) * layout.nx)].map((c) => names[c]).join(''));
}

describe('buildLayout', () => {
  it('keeps the grid frame', () => {
    const layout = buildLayout(source(['..', '..', '..']));
    expect(layout).toMatchObject({ nx: 2, nz: 3, originX: -3, originZ: 12, cell: 0.6 });
    expect(layout.cells).toHaveLength(6);
  });

  it('marks walkable columns as floor and the blocked cells beside them as wall', () => {
    expect(picture(['.....', '.###.', '.###.', '.###.', '.....'], 1)).toEqual(['.....', '.WWW.', '.WSW.', '.WWW.', '.....']);
  });

  it('counts diagonal neighbours and widens the rim on request', () => {
    expect(picture(['.####', '#####', '#####', '#####'], 1)).toEqual(['.WSSS', 'WWSSS', 'SSSSS', 'SSSSS']);
    expect(picture(['.####', '#####', '#####', '#####'], 2)).toEqual(['.WWSS', 'WWWSS', 'WWWSS', 'SSSSS']);
  });

  it('treats a column whose nodes cannot be reached as blocked', () => {
    expect(picture(['.x#'], 1)).toEqual(['.WS']);
  });

  it('treats a column as floor when any of its levels is walkable', () => {
    expect(picture(['2#'], 1)).toEqual(['.W']);
  });

  it('is all solid when nothing is walkable', () => {
    expect(picture(['##', '##'])).toEqual(['SS', 'SS']);
  });
});

describe('toMap', () => {
  const point: MapPoint = { x: 0, y: 0, outside: false };
  const SCALE = 2;
  const LIMIT = 90;

  it('puts what is ahead at the top and what is to the right on the right (yaw 0 looks down -Z)', () => {
    toMap(point, 0, -10, 0, SCALE, LIMIT);
    expect(point.x).toBeCloseTo(0);
    expect(point.y).toBeCloseTo(-20);
    expect(point.outside).toBe(false);
    toMap(point, 10, 0, 0, SCALE, LIMIT);
    expect(point.x).toBeCloseTo(20);
    expect(point.y).toBeCloseTo(0);
  });

  it('rotates with the player', () => {
    // Yaw +90 degrees turns left, to face -X.
    toMap(point, -10, 0, Math.PI / 2, SCALE, LIMIT);
    expect(point.x).toBeCloseTo(0);
    expect(point.y).toBeCloseTo(-20);
    // Something at -Z is then on the player's right.
    toMap(point, 0, -10, Math.PI / 2, SCALE, LIMIT);
    expect(point.x).toBeCloseTo(20);
    expect(point.y).toBeCloseTo(0);
    // Facing +Z, what lies at +Z is ahead.
    toMap(point, 0, 5, Math.PI, SCALE, LIMIT);
    expect(point.x).toBeCloseTo(0);
    expect(point.y).toBeCloseTo(-10);
  });

  it('clamps points past the limit to the edge and keeps their bearing', () => {
    toMap(point, 300, -400, 0, SCALE, LIMIT);
    expect(point.outside).toBe(true);
    expect(Math.hypot(point.x, point.y)).toBeCloseTo(LIMIT);
    expect(point.x / point.y).toBeCloseTo(300 / -400);
    expect(point.y).toBeLessThan(0);
  });

  it('leaves a point on the limit alone', () => {
    toMap(point, 0, -45, 0, SCALE, LIMIT);
    expect(point.outside).toBe(false);
    expect(point.y).toBeCloseTo(-90);
  });

  it('returns the object it was given', () => {
    expect(toMap(point, 1, 1, 0, SCALE, LIMIT)).toBe(point);
  });
});

describe('horizontalHalfFov', () => {
  it('is half the vertical angle on a square view', () => {
    expect(horizontalHalfFov(90, 1)).toBeCloseTo(Math.PI / 4);
  });
  it('widens with the aspect ratio', () => {
    expect(horizontalHalfFov(78, 16 / 9)).toBeCloseTo(Math.atan(Math.tan((39 * Math.PI) / 180) * (16 / 9)));
  });
});

describe('shotAge', () => {
  it('is the time since the shot', () => {
    expect(shotAge(10, 10.4)).toBeCloseTo(0.4);
  });
  it('is never for a shooter with no shot on record or a shot from a previous match clock', () => {
    expect(shotAge(undefined, 5)).toBe(Infinity);
    expect(shotAge(40, 5)).toBe(Infinity);
  });
});
