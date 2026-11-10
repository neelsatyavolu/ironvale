import { describe, expect, it } from 'vitest';
import { SnapshotBuffer, lerpAngle, type Pose, type Snapshot } from '../../src/net/interp';

const snap = (time: number, x: number, patch: Partial<Snapshot> = {}): Snapshot => ({
  time,
  epoch: 0,
  x,
  y: 0,
  z: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  yaw: 0,
  pitch: 0,
  ...patch,
});

const pose = (): Pose => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0 });

describe('SnapshotBuffer', () => {
  it('reports empty until something arrives', () => {
    const buffer = new SnapshotBuffer();
    expect(buffer.sample(100, pose())).toBe('empty');
  });

  it('interpolates between the two snapshots around the render time', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snap(1000, 0));
    buffer.push(snap(1100, 10));
    const out = pose();
    expect(buffer.sample(1025, out)).toBe('interpolated');
    expect(out.x).toBeCloseTo(2.5, 6);
  });

  it('holds the oldest snapshot when the render time is before it', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snap(1000, 4));
    buffer.push(snap(1100, 10));
    const out = pose();
    expect(buffer.sample(900, out)).toBe('held');
    expect(out.x).toBe(4);
  });

  it('moves smoothly across many snapshots', () => {
    const buffer = new SnapshotBuffer();
    for (let i = 0; i <= 30; i++) buffer.push(snap(i * 33, i * 0.2));
    const out = pose();
    let previous = -Infinity;
    let largestStep = 0;
    for (let t = 0; t <= 990; t += 8) {
      buffer.sample(t, out);
      expect(out.x).toBeGreaterThanOrEqual(previous);
      if (previous > -Infinity) largestStep = Math.max(largestStep, out.x - previous);
      previous = out.x;
    }
    // 0.2 m every 33 ms sampled every 8 ms: no step should be much more than 5 cm.
    expect(largestStep).toBeLessThan(0.06);
  });

  it('puts late and out-of-order snapshots in their place and drops duplicates', () => {
    const buffer = new SnapshotBuffer();
    expect(buffer.push(snap(1000, 0))).toBe(true);
    expect(buffer.push(snap(1200, 20))).toBe(true);
    expect(buffer.push(snap(1100, 10))).toBe(true);
    expect(buffer.push(snap(1100, 99))).toBe(false);
    const out = pose();
    buffer.sample(1150, out);
    expect(out.x).toBeCloseTo(15, 6);
  });

  it('extrapolates along the velocity when snapshots stop, up to the cap', () => {
    const buffer = new SnapshotBuffer({ maxExtrapolationMs: 250 });
    buffer.push(snap(1000, 0, { vx: 4 }));
    const out = pose();
    expect(buffer.sample(1100, out)).toBe('extrapolated');
    expect(out.x).toBeCloseTo(0.4, 6);
    expect(buffer.sample(1250, out)).toBe('extrapolated');
    expect(out.x).toBeCloseTo(1, 6);
    expect(buffer.sample(3000, out)).toBe('stalled');
    expect(out.x).toBeCloseTo(1, 6);
    expect(out.vx).toBe(0);
  });

  it('derives velocity from positions when asked', () => {
    const buffer = new SnapshotBuffer({ deriveVelocity: true });
    buffer.push(snap(1000, 0));
    buffer.push(snap(1100, 1));
    const out = pose();
    buffer.sample(1200, out);
    expect(out.x).toBeCloseTo(2, 6);
  });

  it('turns the short way round', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snap(0, 0, { yaw: Math.PI - 0.1 }));
    buffer.push(snap(100, 0, { yaw: -Math.PI + 0.1 }));
    const out = pose();
    buffer.sample(50, out);
    expect(Math.abs(Math.abs(out.yaw) - Math.PI)).toBeLessThan(1e-6);
  });

  it('does not slide between two lives: a respawn snaps', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snap(1000, 0, { epoch: 1 }));
    buffer.push(snap(1100, 50, { epoch: 2 }));
    const out = pose();
    buffer.sample(1050, out);
    expect(out.x).toBe(0);
    buffer.sample(1100, out);
    expect(out.x).toBe(50);
  });

  it('keeps a bounded history', () => {
    const buffer = new SnapshotBuffer({ capacity: 8 });
    for (let i = 0; i < 100; i++) buffer.push(snap(i * 10, i));
    expect(buffer.size).toBe(8);
    expect(buffer.newestTime).toBe(990);
    // Anything older than the kept window is refused.
    expect(buffer.push(snap(5, 0))).toBe(false);
  });

  it('refuses snapshots with values that are not finite', () => {
    const buffer = new SnapshotBuffer();
    expect(buffer.push(snap(Number.NaN, 0))).toBe(false);
    expect(buffer.push(snap(10, Number.POSITIVE_INFINITY))).toBe(false);
    expect(buffer.size).toBe(0);
  });

  it('forgets everything on reset', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snap(1, 1));
    buffer.reset();
    expect(buffer.sample(1, pose())).toBe('empty');
  });
});

describe('lerpAngle', () => {
  it('stays within one turn', () => {
    expect(lerpAngle(3, -3, 0.5)).toBeCloseTo(Math.PI, 1);
    expect(lerpAngle(0, 1, 0.25)).toBeCloseTo(0.25, 6);
  });
});
