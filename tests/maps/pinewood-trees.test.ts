import { describe, expect, it } from 'vitest';
import { seededRandom } from '../../src/core/random';
import { SAPLING_SPEC, TREE_SPECS, crownGeometry, crownRadius } from '../../src/maps/pinewood/tree-geometry';

/** Smallest scale and vertical stretch the forest gives a tree (see placeTrees in trees.ts). */
const MIN_SCALE = 0.8 * 0.9;

function lowestPoint(geometry: ReturnType<typeof crownGeometry>): number {
  const position = geometry.getAttribute('position');
  let lowest = Infinity;
  for (let i = 0; i < position.count; i++) lowest = Math.min(lowest, position.getY(i));
  return lowest;
}

const triangles = (geometry: ReturnType<typeof crownGeometry>): number => (geometry.index?.count ?? 0) / 3;

describe('pinewood tree crowns', () => {
  it('keeps every bough of a full-size tree above a standing player', () => {
    for (const spec of TREE_SPECS) {
      for (const seed of [1, 2, 3]) {
        const crown = crownGeometry(spec, 1, seededRandom(seed));
        expect(lowestPoint(crown) * MIN_SCALE).toBeGreaterThan(2);
      }
    }
  });

  it('draws the distant crown with a fraction of the triangles', () => {
    for (const spec of TREE_SPECS) {
      const near = triangles(crownGeometry(spec, 1, seededRandom(4)));
      const far = triangles(crownGeometry(spec, 0.62, seededRandom(4)));
      expect(near).toBeLessThan(1500);
      expect(far).toBeLessThan(near * 0.3);
      expect(far).toBeGreaterThan(40);
    }
  });

  it('keeps the distant crown as wide and as tall as the close one', () => {
    for (const spec of TREE_SPECS) {
      const size = (detail: number): { width: number; top: number } => {
        const crown = crownGeometry(spec, detail, seededRandom(5));
        crown.computeBoundingBox();
        const box = crown.boundingBox;
        if (!box) throw new Error('crown has no bounds');
        return { width: box.max.x - box.min.x, top: box.max.y };
      };
      const near = size(1);
      const far = size(0.62);
      expect(far.width).toBeGreaterThan(near.width * 0.6);
      expect(far.top).toBeCloseTo(near.top, 1);
    }
  });

  it('tapers the crown to the tip', () => {
    for (const spec of [...TREE_SPECS, SAPLING_SPEC]) {
      expect(crownRadius(spec, 1)).toBeLessThan(0.5);
      expect(crownRadius(spec, 0.3)).toBeGreaterThan(spec.branchLength * 0.6);
    }
  });
});
