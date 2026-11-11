import { describe, expect, it } from 'vitest';
import { between } from '../../src/maps/harbor/cafe';

describe('harbor room panelling', () => {
  it('runs the whole wall when there are no doorways', () => {
    expect(between(0, 10, [])).toEqual([[0, 10]]);
  });

  it('breaks at doorways given in any order', () => {
    expect(
      between(0, 10, [
        [6, 7],
        [2, 3],
      ]),
    ).toEqual([
      [0, 2],
      [3, 6],
      [7, 10],
    ]);
  });

  it('drops slivers beside a doorway and walls that are all gap', () => {
    expect(between(0, 10, [[0.05, 4]])).toEqual([[4, 10]]);
    expect(between(0, 10, [[0, 10]])).toEqual([]);
  });

  it('copes with overlapping gaps', () => {
    expect(
      between(0, 10, [
        [2, 5],
        [4, 6],
      ]),
    ).toEqual([
      [0, 2],
      [6, 10],
    ]);
  });
});
