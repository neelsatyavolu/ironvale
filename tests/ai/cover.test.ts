import { beforeAll, describe, expect, it } from 'vitest';
import { coverAgainst, directionToward, findCover } from '../../src/ai/cover';
import type { NavGrid } from '../../src/ai/navgrid';
import { buildTestGrid, buildTestWorld } from './helpers';

let grid: NavGrid;

beforeAll(() => {
  grid = buildTestGrid(buildTestWorld());
});

describe('cover', () => {
  it('maps a bearing to one of eight directions', () => {
    expect(directionToward(1, 0)).toBe(0);
    expect(directionToward(1, 1)).toBe(1);
    expect(directionToward(0, 1)).toBe(2);
    expect(directionToward(-1, 0)).toBe(4);
    expect(directionToward(0, -1)).toBe(6);
    expect(directionToward(1, -1)).toBe(7);
  });

  it('marks cells beside the tall wall as standing cover from the far side', () => {
    const node = grid.nearestNode(0, 0, -4.4);
    expect(grid.coverLow[node]! & (1 << 6)).not.toBe(0);
    expect(grid.coverHigh[node]! & (1 << 6)).not.toBe(0);
    expect(coverAgainst(grid, node, 0, -15)).toBe(2);
    // Nothing protects it from the open side.
    expect(coverAgainst(grid, node, 0, 15)).toBe(0);
  });

  it('marks cells beside the low wall as crouch cover only', () => {
    const node = grid.nearestNode(0, 0, 9.3);
    expect(coverAgainst(grid, node, 0, 16)).toBe(1);
    expect(coverAgainst(grid, node, 0, 0)).toBe(0);
  });

  it('has no cover out in the open', () => {
    const node = grid.nodeAt(-8, 0, 3);
    expect(grid.coverLow[node]).toBe(0);
    expect(coverAgainst(grid, node, 0, 16)).toBe(0);
  });

  it('finds the nearest spot that protects from the threat', () => {
    // Threat far to the north; soldier south of the tall wall.
    const node = findCover(grid, { x: 1, y: 0, z: -1, threatX: 0, threatZ: -16, radius: 10 });
    expect(node).toBeGreaterThanOrEqual(0);
    expect(coverAgainst(grid, node, 0, -16)).toBeGreaterThan(0);
    expect(grid.nodeZ(node)).toBeGreaterThan(-5);
    expect(Math.hypot(grid.nodeX(node) - 1, grid.nodeZ(node) + 1)).toBeLessThan(5);
  });

  it('skips spots that are taken, too close to the threat, or out of reach', () => {
    const query = { x: 1, y: 0, z: -1, threatX: 0, threatZ: -16, radius: 10 };
    const first = findCover(grid, query);
    const second = findCover(grid, { ...query, taken: [first] });
    expect(second).toBeGreaterThanOrEqual(0);
    expect(second).not.toBe(first);
    expect(findCover(grid, { ...query, radius: 1.5, x: -9, z: 4 })).toBe(-1);
    const far = findCover(grid, { ...query, minThreatDistance: 20 });
    expect(far < 0 || Math.hypot(grid.nodeX(far), grid.nodeZ(far) + 16) >= 20).toBe(true);
  });

  it('can prefer cover further from the threat when falling back', () => {
    // Soldier between the walls, threat just north of the tall wall: the low wall's far side is cover too.
    const near = findCover(grid, { x: 0, y: 0, z: 2, threatX: 0, threatZ: -7, radius: 14 });
    const away = findCover(grid, { x: 0, y: 0, z: 2, threatX: 0, threatZ: -7, radius: 14, idealThreatDistance: 16 });
    expect(away).toBeGreaterThanOrEqual(0);
    expect(grid.nodeZ(away)).toBeGreaterThan(grid.nodeZ(near));
  });
});
