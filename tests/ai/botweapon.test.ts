import { describe, expect, it } from 'vitest';
import { AimModel, aimErrorDegrees } from '../../src/ai/aim';
import { BotWeapon } from '../../src/ai/botweapon';
import { DIFFICULTY, DIFFICULTY_ORDER } from '../../src/ai/difficulty';
import { WEAPON_DEFS } from '../../src/weapons/defs';

const FRAME = 1 / 60;

/** Hold the trigger for `seconds`; returns the time of every shot. */
function hold(weapon: BotWeapon, seconds: number, from = 0): number[] {
  const shots: number[] = [];
  for (let t = from; t < from + seconds; t += FRAME) if (weapon.update(FRAME, true)) shots.push(t);
  return shots;
}

describe('BotWeapon bursts', () => {
  const fixed = { burstMin: 3, burstMax: 3, pauseMin: 1, pauseMax: 1 };

  it('fires at the weapon rate of fire inside a burst', () => {
    const weapon = new BotWeapon(WEAPON_DEFS.m4a1, fixed, () => 0.5);
    const shots = hold(weapon, 0.5);
    expect(shots).toHaveLength(3);
    // 800 rounds per minute is 75 ms between rounds; a 60 Hz frame adds at most one frame of error.
    expect(shots[2]! - shots[0]!).toBeGreaterThan(0.15 - FRAME);
    expect(shots[2]! - shots[0]!).toBeLessThan(0.15 + FRAME);
  });

  it('pauses between bursts', () => {
    const weapon = new BotWeapon(WEAPON_DEFS.m4a1, fixed, () => 0.5);
    const shots = hold(weapon, 2.6);
    expect(shots).toHaveLength(9);
    expect(shots[3]! - shots[2]!).toBeGreaterThanOrEqual(1 - 1e-6);
    expect(shots[3]! - shots[2]!).toBeLessThan(1.1);
  });

  it('picks burst lengths and pauses inside the given limits', () => {
    let seed = 0;
    const random = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    const weapon = new BotWeapon(WEAPON_DEFS.m249, { burstMin: 4, burstMax: 7, pauseMin: 0.4, pauseMax: 0.8 }, random);
    const shots = hold(weapon, 12);
    const bursts: number[] = [];
    let run = 1;
    for (let i = 1; i < shots.length; i++) {
      const gap = shots[i]! - shots[i - 1]!;
      if (gap > 0.3) {
        bursts.push(run);
        run = 1;
        expect(gap).toBeGreaterThanOrEqual(0.4 - 1e-6);
        expect(gap).toBeLessThan(0.8 + 0.1);
      } else run++;
    }
    expect(bursts.length).toBeGreaterThan(5);
    for (const burst of bursts) {
      expect(burst).toBeGreaterThanOrEqual(4);
      expect(burst).toBeLessThanOrEqual(7);
    }
    expect(new Set(bursts).size).toBeGreaterThan(1);
  });

  it('never fires without the trigger held, and letting go ends the burst', () => {
    const weapon = new BotWeapon(WEAPON_DEFS.m4a1, fixed, () => 0.5);
    for (let t = 0; t < 1; t += FRAME) expect(weapon.update(FRAME, false)).toBe(false);
    expect(weapon.update(FRAME, true)).toBe(true);
    weapon.update(FRAME, false);
    expect(hold(weapon, 0.5)).toHaveLength(3);
  });

  it('respects a slower shot interval than the action allows (marksman)', () => {
    const weapon = new BotWeapon(WEAPON_DEFS.m24, { burstMin: 1, burstMax: 1, pauseMin: 2, pauseMax: 2 }, () => 0.5);
    const shots = hold(weapon, 9);
    expect(shots.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < shots.length; i++) expect(shots[i]! - shots[i - 1]!).toBeGreaterThanOrEqual(2 - 1e-6);
    // The bolt alone limits a 42 rpm rifle to one round every 1.43 s.
    const fast = new BotWeapon(WEAPON_DEFS.m24, { burstMin: 5, burstMax: 5, pauseMin: 0, pauseMax: 0 }, () => 0.5);
    const cycled = hold(fast, 4);
    expect(cycled[1]! - cycled[0]!).toBeGreaterThanOrEqual(60 / 42 - FRAME);
  });
});

describe('BotWeapon magazine and reload', () => {
  const spray = { burstMin: 100, burstMax: 100, pauseMin: 0, pauseMax: 0 };

  it('empties exactly one magazine, then reloads for the weapon reload time', () => {
    const weapon = new BotWeapon(WEAPON_DEFS.m4a1, spray, () => 0.5);
    const shots = hold(weapon, 30 * 0.075 + 0.2);
    expect(shots).toHaveLength(30);
    expect(weapon.magazine).toBe(0);
    expect(weapon.reloading).toBe(true);
    const during = hold(weapon, 2.3 - 0.3, 10);
    expect(during).toHaveLength(0);
    expect(weapon.reloading).toBe(true);
    const after = hold(weapon, 0.5, 20);
    expect(weapon.reloading).toBe(false);
    expect(after.length).toBeGreaterThan(0);
    expect(weapon.magazine).toBe(30 - after.length);
  });

  it('flags the frames a reload starts and ends', () => {
    const weapon = new BotWeapon(WEAPON_DEFS.m4a1, spray, () => 0.5);
    let started = 0;
    let finished = 0;
    for (let t = 0; t < 6; t += FRAME) {
      weapon.update(FRAME, true);
      if (weapon.reloadStarted) started++;
      if (weapon.reloadFinished) finished++;
    }
    expect(started).toBe(1);
    expect(finished).toBe(1);
  });

  it('can top up early, and does nothing when already full', () => {
    const weapon = new BotWeapon(WEAPON_DEFS.m4a1, spray, () => 0.5);
    weapon.startReload();
    expect(weapon.reloading).toBe(false);
    hold(weapon, 0.5);
    weapon.startReload();
    expect(weapon.reloading).toBe(true);
    for (let t = 0; t < 2.4; t += FRAME) weapon.update(FRAME, false);
    expect(weapon.magazine).toBe(30);
  });
});

describe('AimModel', () => {
  const make = (level: (typeof DIFFICULTY_ORDER)[number]) => new AimModel(DIFFICULTY[level]);

  it('turns a miss distance at 20 m into a cone angle', () => {
    expect(aimErrorDegrees(1)).toBeCloseTo(2.862, 2);
    expect(aimErrorDegrees(0.3)).toBeCloseTo(0.859, 2);
  });

  it('is least accurate on the first shots at a new target and tightens while tracking', () => {
    const aim = make('regular');
    const first = aim.spread(0, false);
    let previous = first;
    for (let i = 0; i < 600; i++) {
      aim.update(FRAME, true);
      const now = aim.spread(0, false);
      expect(now).toBeLessThanOrEqual(previous);
      previous = now;
    }
    expect(first).toBeGreaterThan(previous * 1.5);
    expect(previous).toBeCloseTo(aimErrorDegrees(DIFFICULTY.regular.aimErrorAt20m), 1);
  });

  it('loosens again after losing the target and starts over on a new one', () => {
    const aim = make('regular');
    for (let i = 0; i < 600; i++) aim.update(FRAME, true);
    const settled = aim.spread(0, false);
    for (let i = 0; i < 60; i++) aim.update(FRAME, false);
    expect(aim.spread(0, false)).toBeGreaterThan(settled);
    aim.reset();
    expect(aim.spread(0, false)).toBeCloseTo(make('regular').spread(0, false), 6);
  });

  it('is worse against a fast-crossing target, while moving, and just after being hit', () => {
    const aim = make('regular');
    for (let i = 0; i < 600; i++) aim.update(FRAME, true);
    const settled = aim.spread(0, false);
    expect(aim.spread(20, false)).toBeGreaterThan(settled);
    expect(aim.spread(0, true)).toBeGreaterThan(settled);
    aim.disturb(2);
    expect(aim.spread(0, false)).toBeGreaterThan(settled + 1.5);
    for (let i = 0; i < 180; i++) aim.update(FRAME, true);
    expect(aim.spread(0, false)).toBeCloseTo(settled, 1);
  });

  it('is tighter at every moment on a harder setting', () => {
    const aims = DIFFICULTY_ORDER.map(make);
    for (let frame = 0; frame < 240; frame++) {
      for (let i = 1; i < aims.length; i++) {
        expect(aims[i]!.spread(10, false)).toBeLessThan(aims[i - 1]!.spread(10, false));
      }
      for (const aim of aims) aim.update(FRAME, true);
    }
  });
});
