import { describe, expect, it } from 'vitest';
import { BOUNDS, ENEMY_SPAWNS, PLAYER_SPAWNS, TERRACE_Y } from '../../src/maps/harbor/layout';
import { bayCentres, wallPieces, type Rect } from '../../src/maps/harbor/pieces';

const area = (rects: readonly Rect[]): number => rects.reduce((sum, r) => sum + (r.u1 - r.u0) * (r.v1 - r.v0), 0);
const overlaps = (a: Rect, b: Rect): boolean =>
  a.u0 < b.u1 - 1e-9 && b.u0 < a.u1 - 1e-9 && a.v0 < b.v1 - 1e-9 && b.v0 < a.v1 - 1e-9;

describe('wallPieces', () => {
  it('returns the whole wall when there are no openings', () => {
    expect(wallPieces(8, 6, [])).toEqual([{ u0: 0, u1: 8, v0: 0, v1: 6 }]);
  });

  it('cuts a window into left, below, above and right pieces', () => {
    const window: Rect = { u0: 3, u1: 4, v0: 1, v1: 2.4 };
    const pieces = wallPieces(8, 3, [window]);
    expect(pieces).toHaveLength(4);
    expect(area(pieces)).toBeCloseTo(8 * 3 - 1.4);
    expect(pieces.some((piece) => overlaps(piece, window))).toBe(false);
  });

  it('leaves no piece under a door that starts at the floor', () => {
    const door: Rect = { u0: 1, u1: 1.95, v0: 0, v1: 2.1 };
    const pieces = wallPieces(4, 3, [door]);
    expect(pieces).toHaveLength(3);
    expect(pieces.some((piece) => overlaps(piece, door))).toBe(false);
    expect(area(pieces)).toBeCloseTo(4 * 3 - 0.95 * 2.1);
  });

  it('handles openings stacked in one bay and side by side', () => {
    const openings: Rect[] = [
      { u0: 1, u1: 2, v0: 1, v1: 2.4 },
      { u0: 1, u1: 2, v0: 4, v1: 5.4 },
      { u0: 5, u1: 6, v0: 4, v1: 5.4 },
    ];
    const pieces = wallPieces(8, 6, openings);
    expect(area(pieces)).toBeCloseTo(8 * 6 - 3 * 1.4);
    for (const opening of openings) expect(pieces.some((piece) => overlaps(piece, opening))).toBe(false);
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) expect(overlaps(pieces[i]!, pieces[j]!)).toBe(false);
    }
  });

  it('clips openings that run past the wall', () => {
    const pieces = wallPieces(4, 3, [{ u0: 3.5, u1: 5, v0: -1, v1: 2 }]);
    expect(area(pieces)).toBeCloseTo(4 * 3 - 0.5 * 2);
  });
});

describe('bayCentres', () => {
  it('spreads bays evenly and keeps them off the corners', () => {
    const centres = bayCentres(9, 3);
    expect(centres).toHaveLength(3);
    expect(centres[0]).toBeCloseTo(1.5);
    expect(centres[2]).toBeCloseTo(7.5);
  });

  it('always returns at least one bay', () => {
    expect(bayCentres(2, 3)).toEqual([1]);
  });
});

describe('harbor layout', () => {
  it('has four player spawns at the east end and ten or more enemy spawns', () => {
    expect(PLAYER_SPAWNS).toHaveLength(4);
    expect(ENEMY_SPAWNS.length).toBeGreaterThanOrEqual(10);
    for (const spawn of PLAYER_SPAWNS) expect(spawn.x).toBeGreaterThan(35);
  });

  it('keeps every spawn inside the bounds and just above a floor level', () => {
    for (const spawn of [...PLAYER_SPAWNS, ...ENEMY_SPAWNS]) {
      expect(spawn.x).toBeGreaterThan(BOUNDS.minX);
      expect(spawn.x).toBeLessThan(BOUNDS.maxX);
      expect(spawn.z).toBeGreaterThan(BOUNDS.minZ);
      expect(spawn.z).toBeLessThan(BOUNDS.maxZ);
      const floors = [0, TERRACE_Y];
      expect(floors.some((floor) => Math.abs(spawn.y - floor - 0.05) < 1e-6)).toBe(true);
    }
  });

  it('puts most enemies in the far half', () => {
    const far = ENEMY_SPAWNS.filter((spawn) => spawn.x < 0).length;
    expect(far).toBeGreaterThanOrEqual(ENEMY_SPAWNS.length * 0.6);
  });
});
