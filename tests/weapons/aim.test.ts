import { describe, expect, it } from 'vitest';
import { AimState, BreathSway, type AimInput } from '../../src/weapons/aim';

const DT = 1 / 120;
const BASE: AimInput = { held: false, pressed: false, toggle: false, allowed: true, aimTime: 0.24 };

function run(aim: AimState, seconds: number, input: AimInput): number {
  let changes = 0;
  for (let i = 0; i < Math.round(seconds / DT); i++) if (aim.update(DT, input)) changes++;
  return changes;
}

describe('AimState, hold to aim', () => {
  it('raises the sights over the aim time and lowers them on release', () => {
    const aim = new AimState();
    const hold = { ...BASE, held: true };
    run(aim, 0.12, hold);
    expect(aim.blend).toBeGreaterThan(0.4);
    expect(aim.blend).toBeLessThan(0.6);
    run(aim, 0.13, hold);
    expect(aim.blend).toBe(1);
    run(aim, 0.3, BASE);
    expect(aim.blend).toBe(0);
  });

  it('reports each change of state once', () => {
    const aim = new AimState();
    expect(run(aim, 0.5, { ...BASE, held: true })).toBe(1);
    expect(aim.aiming).toBe(true);
    expect(run(aim, 0.5, BASE)).toBe(1);
    expect(aim.aiming).toBe(false);
  });

  it('lowers while aiming is not allowed and comes back up after', () => {
    const aim = new AimState();
    const hold = { ...BASE, held: true };
    run(aim, 0.5, hold);
    run(aim, 0.5, { ...hold, allowed: false });
    expect(aim.blend).toBe(0);
    run(aim, 0.5, hold);
    expect(aim.blend).toBe(1);
  });
});

describe('AimState, toggle to aim', () => {
  const toggle = { ...BASE, toggle: true };

  it('stays aimed after one press and lowers on the next', () => {
    const aim = new AimState();
    aim.update(DT, { ...toggle, pressed: true, held: true });
    run(aim, 0.5, toggle);
    expect(aim.blend).toBe(1);
    aim.update(DT, { ...toggle, pressed: true, held: true });
    run(aim, 0.5, toggle);
    expect(aim.blend).toBe(0);
  });

  it('ignores holding the button', () => {
    const aim = new AimState();
    run(aim, 0.5, { ...toggle, held: true });
    expect(aim.blend).toBe(0);
  });

  it('forgets the toggle when dropped', () => {
    const aim = new AimState();
    aim.update(DT, { ...toggle, pressed: true });
    run(aim, 0.5, toggle);
    aim.drop();
    run(aim, 0.5, toggle);
    expect(aim.blend).toBe(0);
    expect(aim.aiming).toBe(false);
  });

  it('keeps the toggle through a spell where aiming is not allowed', () => {
    const aim = new AimState();
    aim.update(DT, { ...toggle, pressed: true });
    run(aim, 0.5, { ...toggle, allowed: false });
    expect(aim.blend).toBe(0);
    run(aim, 0.5, toggle);
    expect(aim.blend).toBe(1);
  });
});

describe('BreathSway', () => {
  function peak(sway: BreathSway, seconds: number, hold: boolean, amount = 1): number {
    let max = 0;
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      sway.update(DT, amount, hold, 1);
      max = Math.max(max, Math.hypot(sway.yaw, sway.pitch));
    }
    return max;
  }

  it('drifts slowly and stays small', () => {
    const sway = new BreathSway();
    const max = peak(sway, 12, false);
    expect(max).toBeGreaterThan(0.0008);
    expect(max).toBeLessThan(0.008);
  });

  it('steadies while the breath is held', () => {
    const loose = peak(new BreathSway(), 3, false);
    const held = new BreathSway();
    peak(held, 0.6, true);
    const steady = peak(held, 2.4, true);
    expect(steady).toBeLessThan(loose * 0.3);
    expect(held.steady).toBe(true);
  });

  it('runs out of breath, sways harder, and needs time to recover', () => {
    const sway = new BreathSway();
    const normal = peak(new BreathSway(), 6, false);
    peak(sway, 6, true);
    expect(sway.steady).toBe(false);
    expect(sway.exhausted).toBe(true);
    // Still holding the key does nothing while exhausted.
    const winded = peak(sway, 1.5, true);
    expect(winded).toBeGreaterThan(normal);
    peak(sway, 6, false);
    expect(sway.exhausted).toBe(false);
    expect(sway.breath).toBeGreaterThan(0.9);
    peak(sway, 0.5, true);
    expect(sway.steady).toBe(true);
  });

  it('returns to centre when the scope comes down, with no net turn', () => {
    const sway = new BreathSway();
    let sumYaw = 0;
    let sumPitch = 0;
    const step = (amount: number) => {
      sway.update(DT, amount, false, 1);
      sumYaw += sway.deltaYaw;
      sumPitch += sway.deltaPitch;
    };
    for (let i = 0; i < 600; i++) step(1);
    for (let i = 0; i < 240; i++) step(0);
    expect(Math.abs(sway.yaw)).toBeLessThan(1e-5);
    expect(Math.abs(sumYaw)).toBeLessThan(1e-5);
    expect(Math.abs(sumPitch)).toBeLessThan(1e-5);
  });
});
