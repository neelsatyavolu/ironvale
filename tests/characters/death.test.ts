import { describe, expect, it } from 'vitest';
import { CLIP_META } from '../../src/characters/clip-meta';
import { DEATH, deathFrame, planDeath, type DeathFrame } from '../../src/characters/death';

const frame = (variant: 'back' | 'front', elapsed: number): DeathFrame =>
  deathFrame(variant, elapsed, { clipTime: 0, blend: 0, ikWeight: 1, turn: 0, settled: false });

describe('planDeath', () => {
  it('falls backwards without turning when shot from the front', () => {
    // The soldier faces -Z, so a bullet from the front travels +Z.
    const plan = planDeath(0, 1);
    expect(plan.variant).toBe('back');
    expect(plan.turn).toBeCloseTo(0);
  });

  it('falls forwards when shot from behind', () => {
    const plan = planDeath(0, -1);
    expect(plan.variant).toBe('front');
    expect(plan.turn).toBeCloseTo(0);
  });

  it('turns the fall toward where the bullet was going', () => {
    // Backward fall heads +Z; turned by `turn` about Y it heads (sin, cos).
    const back = planDeath(0.5, 1);
    expect(Math.sin(back.turn)).toBeGreaterThan(0);
    expect(back.turn).toBeCloseTo(Math.atan2(0.5, 1));
    // Forward fall heads -Z; turned it heads (-sin, -cos).
    const front = planDeath(0.5, -1);
    expect(front.variant).toBe('front');
    expect(-Math.sin(front.turn)).toBeCloseTo(0.5 / Math.hypot(0.5, 1));
  });

  it('limits the turn for a shot from the side, so the body is not spun like a top', () => {
    const fromRight = planDeath(-1, 0);
    expect(fromRight.variant).toBe('back');
    expect(fromRight.turn).toBeCloseTo(-DEATH.maxTurn);
    expect(Math.abs(planDeath(1, -0.2).turn)).toBeLessThanOrEqual(DEATH.maxTurn + 1e-9);
  });

  it('picks the fall whose direction is closer to the bullet', () => {
    expect(planDeath(1, 0.5).variant).toBe('back');
    expect(planDeath(1, -0.8).variant).toBe('front');
  });

  it('copes with a bullet that came straight down', () => {
    expect(planDeath(0, 0)).toEqual({ variant: 'back', turn: 0 });
  });
});

describe('deathFrame', () => {
  it('starts from the living pose with the hands still on the rifle', () => {
    const start = frame('back', 0);
    expect(start.blend).toBe(0);
    expect(start.ikWeight).toBe(1);
    expect(start.turn).toBe(0);
    expect(start.settled).toBe(false);
  });

  it('lets go of the rifle before the fall has fully taken over', () => {
    expect(frame('back', DEATH.ikRelease).ikWeight).toBe(0);
    expect(frame('back', DEATH.blendTime).blend).toBe(1);
    expect(DEATH.ikRelease).toBeLessThanOrEqual(DEATH.blendTime);
  });

  it('only ever moves forward', () => {
    for (const variant of ['back', 'front'] as const) {
      let previous = frame(variant, 0);
      for (let time = 0.01; time < 4; time += 0.01) {
        const now = frame(variant, time);
        expect(now.clipTime).toBeGreaterThanOrEqual(previous.clipTime);
        expect(now.blend).toBeGreaterThanOrEqual(previous.blend);
        expect(now.turn).toBeGreaterThanOrEqual(previous.turn);
        expect(now.ikWeight).toBeLessThanOrEqual(previous.ikWeight);
        previous = now;
      }
    }
  });

  it('finishes the turn while the body is still falling', () => {
    expect(frame('back', DEATH.turnTime).turn).toBeCloseTo(1);
    expect(frame('back', DEATH.turnTime).settled).toBe(false);
  });

  it('holds the last frame of its clip and reports the body at rest', () => {
    const back = frame('back', 10);
    expect(back.clipTime).toBeCloseTo(CLIP_META.death.duration);
    expect(back.settled).toBe(true);
    const front = frame('front', 10);
    expect(front.clipTime).toBeCloseTo(CLIP_META.deathFront.duration);
    expect(front.settled).toBe(true);
  });

  it('is on the ground within about a second and a half', () => {
    expect(frame('front', 1.5).settled).toBe(true);
    expect(frame('back', 1.7).settled).toBe(true);
  });

  it('skips the slow wind-up at the start of the backward fall', () => {
    // The library clip sways on its feet for a third of a second before it drops; a shot body does not.
    expect(frame('back', 0).clipTime).toBeCloseTo(DEATH.variants.back.start);
    expect(DEATH.variants.back.start).toBeGreaterThan(0.2);
    expect(frame('back', 0.2).clipTime).toBeCloseTo(DEATH.variants.back.start + 0.2 * DEATH.variants.back.rate);
    expect(frame('front', 0).clipTime).toBe(0);
  });
});
