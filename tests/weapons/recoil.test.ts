import { describe, expect, it } from 'vitest';
import { seededRandom } from '../../src/core/random';
import { WEAPON_DEFS } from '../../src/weapons/defs';
import { RecoilModel, ViewKickMirror, type Stance } from '../../src/weapons/recoil';

const STANDING: Stance = { aimBlend: 0, crouching: false, speed: 0, airborne: false };
const def = WEAPON_DEFS.m4a1;

describe('RecoilModel kick', () => {
  it('climbs by the weapon profile on the first shot from the hip', () => {
    const recoil = new RecoilModel(seededRandom(1));
    recoil.shot(def, STANDING);
    expect(recoil.kickPitch).toBeCloseTo(def.recoil.vertical, 6);
    expect(Math.abs(recoil.kickYaw)).toBeLessThanOrEqual(def.recoil.horizontal);
  });

  it('grows a little over a sustained burst', () => {
    const recoil = new RecoilModel(seededRandom(1));
    recoil.shot(def, STANDING);
    const first = recoil.kickPitch;
    for (let i = 0; i < 12; i++) {
      recoil.update(0.075);
      recoil.shot(def, STANDING);
    }
    expect(recoil.kickPitch).toBeGreaterThan(first * 1.15);
    expect(recoil.kickPitch).toBeLessThan(first * 1.6);
  });

  it('settles back after a pause', () => {
    const recoil = new RecoilModel(seededRandom(1));
    for (let i = 0; i < 12; i++) {
      recoil.update(0.075);
      recoil.shot(def, STANDING);
    }
    for (let i = 0; i < 60; i++) recoil.update(1 / 60);
    recoil.shot(def, STANDING);
    expect(recoil.kickPitch).toBeCloseTo(def.recoil.vertical, 6);
  });

  it('is lighter when aimed and when crouched', () => {
    const hip = new RecoilModel(seededRandom(1));
    const aimed = new RecoilModel(seededRandom(1));
    const crouched = new RecoilModel(seededRandom(1));
    hip.shot(def, STANDING);
    aimed.shot(def, { ...STANDING, aimBlend: 1 });
    crouched.shot(def, { ...STANDING, crouching: true });
    expect(aimed.kickPitch).toBeLessThan(hip.kickPitch);
    expect(crouched.kickPitch).toBeLessThan(hip.kickPitch);
    expect(Math.abs(aimed.kickYaw)).toBeLessThan(Math.abs(hip.kickYaw));
  });

  it('kicks sideways both ways, about evenly', () => {
    const recoil = new RecoilModel(seededRandom(5));
    let sum = 0;
    let left = 0;
    const count = 2000;
    for (let i = 0; i < count; i++) {
      recoil.shot(def, STANDING);
      recoil.update(1);
      sum += recoil.kickYaw;
      if (recoil.kickYaw < 0) left++;
    }
    expect(Math.abs(sum / count)).toBeLessThan(def.recoil.horizontal * 0.08);
    expect(left / count).toBeGreaterThan(0.4);
    expect(left / count).toBeLessThan(0.6);
  });
});

describe('RecoilModel spread', () => {
  it('is the hip figure standing still and the aimed figure down the sights', () => {
    const recoil = new RecoilModel(seededRandom(1));
    expect(recoil.spread(def, STANDING)).toBeCloseTo(def.spreadHip, 6);
    expect(recoil.spread(def, { ...STANDING, aimBlend: 1 })).toBeCloseTo(def.spreadAim, 6);
  });

  it('grows with movement speed up to the moving figure', () => {
    const recoil = new RecoilModel(seededRandom(1));
    const slow = recoil.spread(def, { ...STANDING, speed: 2 });
    const fast = recoil.spread(def, { ...STANDING, speed: 6 });
    expect(slow).toBeGreaterThan(def.spreadHip);
    expect(fast).toBeGreaterThan(slow);
    expect(fast).toBeCloseTo(def.spreadHip + def.spreadMoving, 6);
  });

  it('opens up in the air and tightens when crouched', () => {
    const recoil = new RecoilModel(seededRandom(1));
    expect(recoil.spread(def, { ...STANDING, airborne: true })).toBeGreaterThan(def.spreadHip * 1.3);
    expect(recoil.spread(def, { ...STANDING, crouching: true })).toBeLessThan(def.spreadHip);
  });

  it('blooms under sustained fire and recovers quickly', () => {
    const recoil = new RecoilModel(seededRandom(1));
    const rest = recoil.spread(def, STANDING);
    for (let i = 0; i < 10; i++) {
      recoil.shot(def, STANDING);
      recoil.update(0.075);
    }
    const hot = recoil.spread(def, STANDING);
    expect(hot).toBeGreaterThan(rest * 1.25);
    expect(hot).toBeLessThan(rest * 2.5);
    for (let i = 0; i < 36; i++) recoil.update(1 / 60);
    expect(recoil.spread(def, STANDING)).toBeLessThan(rest * 1.05);
  });

  it('blooms far less when aimed', () => {
    const recoil = new RecoilModel(seededRandom(1));
    const aimed = { ...STANDING, aimBlend: 1 };
    for (let i = 0; i < 10; i++) {
      recoil.shot(def, aimed);
      recoil.update(0.075);
    }
    expect(recoil.spread(def, aimed)).toBeLessThan(def.spreadHip * 0.4);
  });
});

describe('ViewKickMirror', () => {
  it('accounts for the whole kick and its recovery over time', () => {
    const mirror = new ViewKickMirror();
    mirror.add(2, -1, 0.5);
    let pitch = 0;
    let yaw = 0;
    for (let i = 0; i < 600; i++) {
      mirror.step(1 / 120);
      pitch += mirror.deltaPitch;
      yaw += mirror.deltaYaw;
    }
    const DEG = Math.PI / 180;
    expect(pitch).toBeCloseTo(2 * 0.5 * DEG, 4);
    expect(yaw).toBeCloseTo(-1 * 0.5 * DEG, 4);
  });
});
