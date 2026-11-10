import { describe, expect, it } from 'vitest';
import { seededRandom } from '../../src/core/random';
import { ClockSync } from '../../src/net/clock';

/** One ping: sent at `t` local, the far clock runs `offset` ahead, each leg takes its own time. */
function ping(clock: ClockSync, t: number, offset: number, out: number, back: number): void {
  const remoteTime = t + out + offset;
  clock.addSample(t, remoteTime, t + out + back);
}

describe('ClockSync', () => {
  it('starts unsynced', () => {
    const clock = new ClockSync();
    expect(clock.synced).toBe(false);
    expect(clock.rtt).toBe(-1);
    expect(clock.toLocal(500)).toBe(500);
  });

  it('finds the offset exactly on a symmetric link', () => {
    const clock = new ClockSync();
    ping(clock, 1000, 5000, 20, 20);
    expect(clock.synced).toBe(true);
    expect(clock.offset).toBeCloseTo(5000, 6);
    expect(clock.rtt).toBeCloseTo(40, 6);
    expect(clock.toLocal(6500)).toBeCloseTo(1500, 6);
    expect(clock.toRemote(1500)).toBeCloseTo(6500, 6);
  });

  it('handles a far clock that is behind', () => {
    const clock = new ClockSync();
    ping(clock, 90000, -42000, 15, 15);
    expect(clock.offset).toBeCloseTo(-42000, 6);
  });

  it('trusts the quickest round trip when the link jitters', () => {
    const random = seededRandom(3);
    const clock = new ClockSync();
    for (let i = 0; i < 8; i++) ping(clock, 1000 + i * 250, 777, 20 + random() * 80, 20 + random() * 80);
    ping(clock, 4000, 777, 21, 21);
    expect(Math.abs(clock.offset - 777)).toBeLessThan(1);
  });

  it('bounds the error by half the asymmetry', () => {
    const clock = new ClockSync();
    ping(clock, 0, 100, 10, 50);
    expect(Math.abs(clock.offset - 100)).toBeLessThanOrEqual(20);
  });

  it('follows a change once the old samples age out', () => {
    const clock = new ClockSync();
    for (let i = 0; i < 12; i++) ping(clock, i * 1000, 100, 10, 10);
    for (let i = 12; i < 40; i++) ping(clock, i * 1000, 400, 30, 30);
    expect(clock.offset).toBeCloseTo(400, 6);
  });

  it('smooths the round trip figure', () => {
    const clock = new ClockSync();
    ping(clock, 0, 0, 20, 20);
    ping(clock, 1000, 0, 100, 100);
    expect(clock.rtt).toBeGreaterThan(40);
    expect(clock.rtt).toBeLessThan(200);
  });

  it('ignores samples that cannot be real', () => {
    const clock = new ClockSync();
    clock.addSample(1000, 5000, 900);
    clock.addSample(1000, Number.NaN, 1040);
    clock.addSample(0, 5000, 60_000);
    expect(clock.synced).toBe(false);
  });

  it('resets', () => {
    const clock = new ClockSync();
    ping(clock, 0, 5, 1, 1);
    clock.reset();
    expect(clock.synced).toBe(false);
  });
});
