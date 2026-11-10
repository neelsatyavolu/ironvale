import { describe, expect, it } from 'vitest';
import { pickNeighbour, type Box } from '../../src/ui/focus-nav';

const box = (left: number, top: number, width = 100, height = 40): Box => ({ left, top, width, height });

describe('pickNeighbour', () => {
  // Two rows: three items on top, two below.
  const grid = [box(0, 0), box(120, 0), box(240, 0), box(0, 100), box(240, 100)];

  it('moves along a row', () => {
    expect(pickNeighbour(grid, 0, 'right')).toBe(1);
    expect(pickNeighbour(grid, 2, 'left')).toBe(1);
  });

  it('moves to the nearest item in the next row', () => {
    expect(pickNeighbour(grid, 0, 'down')).toBe(3);
    expect(pickNeighbour(grid, 2, 'down')).toBe(4);
    expect(pickNeighbour(grid, 4, 'up')).toBe(2);
  });

  it('prefers an item that overlaps the current column over a closer one off to the side', () => {
    const boxes = [box(0, 0, 400, 40), box(420, 50, 60, 40), box(0, 200, 400, 40)];
    expect(pickNeighbour(boxes, 0, 'down')).toBe(2);
  });

  it('stays put at an edge', () => {
    expect(pickNeighbour(grid, 0, 'left')).toBe(-1);
    expect(pickNeighbour(grid, 3, 'down')).toBe(-1);
  });

  it('returns nothing for an index outside the list', () => {
    expect(pickNeighbour(grid, 9, 'up')).toBe(-1);
  });
});
