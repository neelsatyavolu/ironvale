import { describe, expect, it } from 'vitest';
import { WeaponSwitch } from '../../src/weapons/switching';

const DT = 1 / 120;
const TIMES = [
  { lowerTime: 0.2, raiseTime: 0.3 },
  { lowerTime: 0.4, raiseTime: 0.6 },
  { lowerTime: 0.1, raiseTime: 0.1 },
];

function setup() {
  const swap = new WeaponSwitch(TIMES.length, (index) => TIMES[index]!);
  const changes: number[] = [];
  const run = (seconds: number) => {
    for (let i = 0; i < Math.round(seconds / DT); i++) if (swap.update(DT)) changes.push(swap.index);
  };
  return { swap, changes, run };
}

describe('WeaponSwitch', () => {
  it('lowers the old gun for its time, then raises the new one for its time', () => {
    const { swap, changes, run } = setup();
    expect(swap.request(1)).toBe(true);
    expect(swap.switching).toBe(true);
    run(0.1);
    expect(swap.index).toBe(0);
    expect(swap.lowered).toBeCloseTo(0.5, 1);
    run(0.11);
    expect(changes).toEqual([1]);
    expect(swap.index).toBe(1);
    expect(swap.lowered).toBeGreaterThan(0.9);
    run(0.3);
    expect(swap.switching).toBe(true);
    expect(swap.lowered).toBeCloseTo(0.5, 1);
    run(0.31);
    expect(swap.switching).toBe(false);
    expect(swap.lowered).toBe(0);
  });

  it('ignores a request for the gun already in hand', () => {
    const { swap } = setup();
    expect(swap.request(0)).toBe(false);
    expect(swap.switching).toBe(false);
  });

  it('ignores slots that do not exist', () => {
    const { swap } = setup();
    expect(swap.request(-1)).toBe(false);
    expect(swap.request(7)).toBe(false);
    expect(swap.switching).toBe(false);
  });

  it('retargets while lowering without starting over', () => {
    const { swap, changes, run } = setup();
    swap.request(1);
    run(0.1);
    expect(swap.request(2)).toBe(false);
    expect(swap.pending).toBe(2);
    run(0.11);
    expect(changes).toEqual([2]);
  });

  it('raises the same gun again when the request is taken back mid-lower', () => {
    const { swap, changes, run } = setup();
    swap.request(1);
    run(0.1);
    swap.request(0);
    run(1);
    expect(changes).toEqual([]);
    expect(swap.index).toBe(0);
    expect(swap.switching).toBe(false);
  });

  it('turns round part-way through raising, from where the gun is', () => {
    const { swap, changes, run } = setup();
    swap.request(1);
    run(0.21);
    run(0.3); // half raised
    expect(swap.request(2)).toBe(true);
    // Half way up, so only about half the lowering time remains.
    run(0.15);
    expect(swap.index).toBe(1);
    run(0.1);
    expect(changes).toEqual([1, 2]);
  });

  it('snaps back to ready on reset', () => {
    const { swap, run } = setup();
    swap.request(1);
    run(0.1);
    swap.reset();
    expect(swap.switching).toBe(false);
    expect(swap.index).toBe(0);
    expect(swap.pending).toBe(0);
  });
});
