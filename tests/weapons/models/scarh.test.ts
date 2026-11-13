import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { SCARH_LAYOUT, SCARH_OPTIC, gripPose, sightPose } from '../../../src/weapons/models/lib/guns-c-layout';
import { HOLO_AXIS_HEIGHT, HOLO_BODY } from '../../../src/weapons/models/lib/guns-c-optic';
import { crown, readGun } from './guns-c-glb';

const layout = SCARH_LAYOUT;
const EVERYWHERE = [-1, 1, -1, 1, -1, 1] as const;

describe('SCAR-H layout', () => {
  it('puts the eye on the optic axis, looking straight down -Z, clear of the sight body', () => {
    const pose = sightPose(layout);
    const forward = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
    expect(forward.z).toBeCloseTo(-1, 9);
    expect(pose.position.x).toBe(0);
    expect(pose.position.y).toBeCloseTo(SCARH_OPTIC.axis, 9);
    expect(pose.position.z - SCARH_OPTIC.rear).toBeGreaterThan(0.06);
  });

  it('holds the gun with the right palm on the right of the grip and the left palm up under the handguard', () => {
    expect(layout.grips.trigger.position[0]).toBeGreaterThan(0);
    const support = gripPose(layout.grips.support);
    expect(new Vector3(1, 0, 0).applyQuaternion(support.quaternion).y).toBeGreaterThan(0.6);
    const trigger = gripPose(layout.grips.trigger);
    expect(new Vector3(-1, 0, 0).applyQuaternion(trigger.quaternion).x).toBeLessThan(-0.9);
  });
});

describe('SCAR-H processed model', async () => {
  const gun = await readGun('scarh');
  const eye = sightPose(layout).position;
  const [boreX, boreY] = layout.muzzle;

  it('is real size, centred and points down -Z', () => {
    expect(gun.size[2]).toBeGreaterThan(layout.realLength * 0.97);
    expect(gun.size[2]).toBeLessThan(layout.realLength * 1.03);
    expect(-gun.min[2]).toBeGreaterThan(gun.max[2]);
    expect(Math.abs(gun.min[0] + gun.max[0])).toBeLessThan(0.02);
    // A Picatinny rail is 21.2 mm across its top; the scale is set from it.
    const rail = gun.within('body', [-0.02, 0.02, SCARH_OPTIC.railTop - 0.003, 1, -0.2, -0.15]);
    expect((rail?.max[0] ?? 0) - (rail?.min[0] ?? 0)).toBeCloseTo(0.0212, 3);
  });

  it('has the muzzle anchor at the centre of the front of the suppressor', () => {
    const front = crown(gun);
    expect(Math.abs(layout.muzzle[2] - front.z)).toBeLessThan(0.001);
    expect(Math.hypot(boreX - front.centre[0], boreY - front.centre[1])).toBeLessThan(0.002);
  });

  it('seats the optic on the top rail, where the source sight was', () => {
    expect(SCARH_OPTIC.axis - SCARH_OPTIC.railTop).toBeCloseTo(HOLO_AXIS_HEIGHT, 4);
    expect(SCARH_OPTIC.rear - SCARH_OPTIC.window).toBeCloseTo(HOLO_BODY.rear, 6);
    const front = SCARH_OPTIC.window + HOLO_BODY.front;
    for (const z of [front + 0.004, SCARH_OPTIC.rear - 0.004]) {
      const footing = gun.within('body', [-0.008, 0.008, SCARH_OPTIC.railTop - 0.006, SCARH_OPTIC.railTop + 0.03, z - 0.008, z + 0.008]);
      expect(footing, `rail at z ${z}`).not.toBeNull();
      expect(Math.abs((footing?.max[1] ?? 0) - SCARH_OPTIC.railTop)).toBeLessThan(0.001);
    }
  });

  it('has a clear sight axis: the source sight and rear flip-up sight are gone', () => {
    expect(gun.crossings('body', [0, SCARH_OPTIC.axis, 0], 2)).toEqual([]);
    // Nothing stands more than the folded front sight's 1.5 mm above the rail, far under the dot.
    expect(gun.max[1]).toBeLessThan(SCARH_OPTIC.railTop + 0.002);
    const behind = gun.within(undefined, [-0.03, 0.03, -1, 1, eye.z - 0.08, 1]);
    expect(SCARH_OPTIC.axis - (behind?.max[1] ?? 1)).toBeGreaterThan(0.03);
  });

  it('puts the support hand just under the bare handguard: the foregrip is gone', () => {
    const [x, y, z] = layout.grips.support.position;
    const underside = gun.crossings('body', [x, 0, z], 1)[0];
    expect(underside - y).toBeGreaterThan(0);
    expect(underside - y).toBeLessThan(0.012);
    expect(gun.within('body', [-0.03, 0.03, -1, underside - 0.003, -0.45, -0.22])).toBeNull();
    expect((gun.within('magazine', EVERYWHERE)?.min[2] ?? 0) - z).toBeGreaterThan(0.1);
  });

  it('has the ejection anchor on the right, at the port ahead of the brass deflector', () => {
    const [x, y, z] = layout.ejection;
    // At the mouth of the port: level with the receiver's outer wall, read just behind the deflector
    // (inside the port, a ray meets only its recessed back; ahead of it, the handguard's side rail).
    const wall = Math.max(...gun.crossings('body', [0, y, z + 0.09], 0));
    const recess = Math.max(...gun.crossings('body', [0, y, z], 0));
    expect(Math.abs(x - wall)).toBeLessThan(0.001);
    expect(wall - recess).toBeGreaterThan(0.002);
    // The deflector stands proud of the receiver just behind the port.
    const deflector = gun.within('body', [0.03, 1, y - 0.01, y + 0.01, z, z + 0.08]);
    expect(deflector).not.toBeNull();
  });

  it('has every moving part as its own unrotated node with room to move', () => {
    for (const name of Object.values(layout.parts)) {
      const part = gun.parts.get(name);
      expect(part, name).toBeDefined();
      expect(part?.rotation).toEqual([0, 0, 0, 1]);
      expect(part?.scale).toEqual([1, 1, 1]);
    }
    // The bolt part is the charging handle on the left of the upper receiver; run back, it stays ahead of the sight.
    const handle = gun.within('bolt', EVERYWHERE);
    expect(handle?.max[0] ?? 1).toBeLessThan(-0.005);
    expect(handle?.min[1] ?? 0).toBeGreaterThan(boreY);
    expect((handle?.max[2] ?? 1) + layout.cycleTravel).toBeLessThan(SCARH_OPTIC.window + HOLO_BODY.front);
    const trigger = gun.within('trigger', EVERYWHERE);
    expect(Math.abs((gun.parts.get('trigger')?.translation[1] ?? 0) - (trigger?.max[1] ?? 1))).toBeLessThan(0.002);
    // The magazine sits in the well ahead of the trigger and drops straight out.
    const magazine = gun.within('magazine', EVERYWHERE);
    expect(magazine?.max[2] ?? 0).toBeLessThan(trigger?.min[2] ?? 1);
  });

  it('keeps one texture set for the gun and a small one for the sling swivel', () => {
    expect([...gun.materials].sort()).toEqual(['scarh_main', 'scarh_swivel']);
    expect(gun.textureTypes.every((type) => type === 'image/webp')).toBe(true);
  });

  it('stays small and uses nothing the loader cannot read', () => {
    expect(gun.bytes).toBeLessThan(1_600_000);
    expect(gun.triangles).toBeLessThan(25_000);
    expect(gun.extensions).toEqual(['EXT_texture_webp']);
  });
});
