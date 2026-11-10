import { describe, expect, it } from 'vitest';
import { DirtyRange, RingPool, scaledCount } from '../../src/fx/pool';

describe('RingPool', () => {
  it('hands out slots in order and recycles the oldest when full', () => {
    const pool = new RingPool(4);
    expect([pool.next(), pool.next(), pool.next(), pool.next()]).toEqual([0, 1, 2, 3]);
    expect(pool.wrapped).toBe(true);
    expect(pool.next()).toBe(0);
    expect(pool.next()).toBe(1);
  });

  it('reports the slot a future allocation will reuse', () => {
    const pool = new RingPool(5);
    pool.next();
    pool.next();
    expect(pool.peek()).toBe(2);
    expect(pool.peek(3)).toBe(0);
    expect(pool.next()).toBe(2);
  });

  it('is not wrapped until every slot has been used once', () => {
    const pool = new RingPool(3);
    pool.next();
    pool.next();
    expect(pool.wrapped).toBe(false);
    pool.next();
    expect(pool.wrapped).toBe(true);
    pool.reset();
    expect(pool.wrapped).toBe(false);
    expect(pool.next()).toBe(0);
  });

  it('rejects an empty pool', () => {
    expect(() => new RingPool(0)).toThrow();
  });
});

describe('DirtyRange', () => {
  it('reports nothing when clean', () => {
    const range = new DirtyRange();
    const calls: number[][] = [];
    range.flush((start, count) => calls.push([start, count]));
    expect(calls).toEqual([]);
  });

  it('covers every marked slot with one span and clears afterwards', () => {
    const range = new DirtyRange();
    range.mark(7);
    range.mark(3);
    range.mark(5);
    const calls: number[][] = [];
    range.flush((start, count) => calls.push([start, count]));
    expect(calls).toEqual([[3, 5]]);
    range.flush((start, count) => calls.push([start, count]));
    expect(calls.length).toBe(1);
  });
});

describe('scaledCount', () => {
  it('scales by density and keeps the fractional part as a chance', () => {
    expect(scaledCount(8, 0.5, 0.99)).toBe(4);
    expect(scaledCount(3, 0.5, 0.2)).toBe(2);
    expect(scaledCount(3, 0.5, 0.8)).toBe(1);
  });

  it('never returns a negative count', () => {
    expect(scaledCount(4, 0, 0.5)).toBe(0);
    expect(scaledCount(4, -1, 0.5)).toBe(0);
  });
});
