import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { damageAt } from '../../../src/weapons/math';
import { WEAPON_DEFS } from '../../../src/weapons/defs';
import { M82_LAYOUT, M82_SCOPE, gripPose, sightPose } from '../../../src/weapons/models/lib/guns-c-layout';
import { crown, readGun } from './guns-c-glb';

const layout = M82_LAYOUT;
const EVERYWHERE = [-1, 1, -1, 1, -1, 1] as const;

describe('M82 stats', () => {
  const def = WEAPON_DEFS.m82;

  it('drops a full-health target with one hit anywhere, at any range it reaches', () => {
    for (const zone of ['head', 'torso', 'limb'] as const) expect(damageAt(def, def.range, zone)).toBeGreaterThanOrEqual(100);
  });

  it('is a scoped semi-automatic that fires without working a bolt', () => {
    expect(def.fireMode).toBe('semi');
    expect(def.scoped).toBe(true);
    expect(def.aimZoom).toBeLessThan(WEAPON_DEFS.m24.aimZoom);
  });

  it('kicks hardest and carries slowest of every gun', () => {
    for (const other of Object.values(WEAPON_DEFS).filter((weapon) => weapon.id !== 'm82')) {
      expect(def.recoil.vertical, other.id).toBeGreaterThan(other.recoil.vertical);
      expect(def.mobility, other.id).toBeLessThan(other.mobility);
    }
  });
});

describe('M82 layout', () => {
  it('puts the eye behind the eyepiece on the scope axis, looking down -Z', () => {
    const pose = sightPose(layout);
    const forward = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
    expect(forward.z).toBeCloseTo(-1, 4);
    expect(pose.position.x).toBe(0);
    expect(pose.position.y).toBeCloseTo(M82_SCOPE.ocular[1], 2);
    expect(pose.position.z - M82_SCOPE.ocular[2]).toBeCloseTo(layout.eyeRelief, 3);
  });

  it('holds the gun with the right palm on the right of the grip and the left palm up under the receiver', () => {
    expect(layout.grips.trigger.position[0]).toBeGreaterThan(0);
    const support = gripPose(layout.grips.support);
    expect(new Vector3(1, 0, 0).applyQuaternion(support.quaternion).y).toBeGreaterThan(0.6);
    const trigger = gripPose(layout.grips.trigger);
    expect(new Vector3(-1, 0, 0).applyQuaternion(trigger.quaternion).x).toBeLessThan(-0.9);
  });
});

describe('M82 processed model', async () => {
  const gun = await readGun('m82');
  const [boreX, boreY] = layout.muzzle;

  it('is real size, centred and points down -Z', () => {
    expect(gun.size[2]).toBeGreaterThan(layout.realLength * 0.99);
    expect(gun.size[2]).toBeLessThan(layout.realLength * 1.01);
    expect(-gun.min[2]).toBeGreaterThan(gun.max[2]);
    expect(Math.abs(gun.min[0] + gun.max[0])).toBeLessThan(0.02);
    // The pistol grip is centred on the origin.
    const grip = gun.within('body', [-0.02, 0.02, -0.05, 0.05, -0.045, 0.045]);
    expect(Math.abs((grip?.min[2] ?? 1) + (grip?.max[2] ?? 1))).toBeLessThan(0.005);
  });

  it('keeps only the rifle: the carry case and the loose cartridges are gone', () => {
    expect(gun.size[0]).toBeLessThan(0.11);
    expect(gun.size[1]).toBeLessThan(0.3);
  });

  it('has the muzzle anchor at the centre of the front of the muzzle brake', () => {
    const front = crown(gun);
    expect(Math.abs(layout.muzzle[2] - front.z)).toBeLessThan(0.001);
    expect(Math.hypot(boreX - front.centre[0], boreY - front.centre[1])).toBeLessThan(0.002);
  });

  it('has the scope lens rings where the sight line says', () => {
    for (const [name, [x, y, z]] of Object.entries(M82_SCOPE)) {
      const ring = gun.within('body', [x - 0.04, x + 0.04, y - 0.04, y + 0.04, z - 0.006, z + 0.006]);
      expect(ring, name).not.toBeNull();
      expect(Math.abs(((ring?.min[1] ?? 0) + (ring?.max[1] ?? 0)) / 2 - y), name).toBeLessThan(0.003);
    }
  });

  it('puts the support hand just under the receiver, ahead of the magazine', () => {
    const [x, y, z] = layout.grips.support.position;
    const underside = gun.crossings('body', [x, 0, z], 1)[0] ?? 0;
    expect(underside - y).toBeGreaterThan(0);
    expect(underside - y).toBeLessThan(0.012);
    expect((gun.within('magazine', EVERYWHERE)?.min[2] ?? 0) - z).toBeGreaterThan(0.04);
  });

  it('has the ejection anchor on the right of the receiver', () => {
    const [x, y, z] = layout.ejection;
    // The port is open on the right at this height: a ray meets the receiver's left wall, then only the bolt carrier.
    expect(Math.max(...gun.crossings('body', [0, y, z], 0))).toBeLessThan(0);
    const carrier = Math.max(...gun.crossings('bolt', [0, y, z], 0));
    expect(Math.abs(x - carrier)).toBeLessThan(0.002);
  });

  it('has every moving part as its own unrotated node with room to move', () => {
    for (const name of Object.values(layout.parts)) {
      const part = gun.parts.get(name);
      expect(part, name).toBeDefined();
      expect(part?.rotation).toEqual([0, 0, 0, 1]);
      expect(part?.scale).toEqual([1, 1, 1]);
    }
    // The bolt carrier and its charging handle sit above the bore, the handle out on the right.
    const bolt = gun.within('bolt', EVERYWHERE);
    expect(bolt?.min[1] ?? 0).toBeGreaterThan(boreY - 0.03);
    expect(bolt?.max[0] ?? 0).toBeGreaterThan(0.02);
    // Run back, it stays ahead of the stock's cheek rest.
    expect((bolt?.max[2] ?? 1) + layout.cycleTravel).toBeLessThan(0.05);
    const trigger = gun.within('trigger', EVERYWHERE);
    expect(Math.abs((gun.parts.get('trigger')?.translation[1] ?? 0) - (trigger?.max[1] ?? 1))).toBeLessThan(0.003);
    // The magazine sits in the well ahead of the trigger and drops straight out.
    const magazine = gun.within('magazine', EVERYWHERE);
    expect(magazine?.max[2] ?? 0).toBeLessThan(trigger?.min[2] ?? 1);
  });

  it('keeps three texture sets: rifle and scope, bolt group, scope rings', () => {
    expect([...gun.materials].sort()).toEqual(['m82_bolt', 'm82_main', 'm82_rings']);
    expect(gun.textureTypes.every((type) => type === 'image/webp')).toBe(true);
  });

  it('stays small and uses nothing the loader cannot read', () => {
    expect(gun.bytes).toBeLessThan(1_800_000);
    expect(gun.triangles).toBeLessThan(30_000);
    expect(gun.extensions).toEqual(['EXT_texture_webp']);
  });
});
