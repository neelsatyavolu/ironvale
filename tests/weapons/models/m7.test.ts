import { Quaternion, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { M7_LAYOUT, M7_OPTIC, gripPose, sightPose } from '../../../src/weapons/models/lib/guns-c-layout';
import { HOLO_AXIS_HEIGHT, HOLO_BODY } from '../../../src/weapons/models/lib/guns-c-optic';
import { crown, readGun } from './guns-c-glb';

const layout = M7_LAYOUT;
const EVERYWHERE = [-1, 1, -1, 1, -1, 1] as const;

describe('M7 layout', () => {
  it('puts the eye on the optic axis, looking straight down -Z', () => {
    const pose = sightPose(layout);
    const forward = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
    expect(forward.x).toBeCloseTo(0, 9);
    expect(forward.y).toBeCloseTo(0, 9);
    expect(forward.z).toBeCloseTo(-1, 9);
    expect(pose.position.x).toBe(0);
    expect(pose.position.y).toBeCloseTo(M7_OPTIC.axis, 9);
  });

  it('keeps the eye far enough behind the sight body that the 4 cm near plane cannot cut into it', () => {
    const pose = sightPose(layout);
    expect(pose.position.z - M7_OPTIC.rear).toBeGreaterThan(0.06);
    expect(pose.position.z).toBeLessThan(0.12);
  });

  it('builds grip frames with -Z along the fingers and +Y toward the thumb', () => {
    for (const spec of [layout.grips.trigger, layout.grips.support]) {
      const pose = gripPose(spec);
      const fingers = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
      const thumb = new Vector3(0, 1, 0).applyQuaternion(pose.quaternion);
      expect(fingers.distanceTo(new Vector3(...spec.fingers).normalize())).toBeLessThan(1e-6);
      expect(thumb.dot(new Vector3(...spec.thumb))).toBeGreaterThan(0);
      expect(thumb.dot(fingers)).toBeCloseTo(0, 6);
      expect(new Quaternion().copy(pose.quaternion).length()).toBeCloseTo(1, 6);
    }
  });

  it('holds the gun with the right palm on the right of the grip and the left hand under the handguard', () => {
    expect(layout.grips.trigger.position[0]).toBeGreaterThan(0);
    expect(layout.grips.support.position[2]).toBeLessThan(-0.2);
    // Palm normals: the right palm faces left (-X of its frame), the left palm faces up.
    const support = gripPose(layout.grips.support);
    const leftPalmNormal = new Vector3(1, 0, 0).applyQuaternion(support.quaternion);
    expect(leftPalmNormal.y).toBeGreaterThan(0.6);
    const trigger = gripPose(layout.grips.trigger);
    const rightPalmNormal = new Vector3(-1, 0, 0).applyQuaternion(trigger.quaternion);
    expect(rightPalmNormal.x).toBeLessThan(-0.9);
  });
});

describe('M7 processed model', async () => {
  const gun = await readGun('m7');
  const eye = sightPose(layout).position;
  const [boreX, boreY] = layout.muzzle;
  /** Front end of the handguard, which is the largest single piece of the body. */
  const handguardFront = [...gun.pieces('body')].sort((a, b) => b.triangles - a.triangles)[0].min[2];

  it('is real size and points down -Z', () => {
    expect(gun.size[2]).toBeGreaterThan(layout.realLength * 0.97);
    expect(gun.size[2]).toBeLessThan(layout.realLength * 1.03);
    expect(-gun.min[2]).toBeGreaterThan(gun.max[2]);
    expect(Math.abs(gun.min[0] + gun.max[0])).toBeLessThan(0.01);
    // The top rail has the real 10 mm pitch only if the scale is right: its top flat is 15 mm wide.
    const rail = gun.within('body', [-1, 1, M7_OPTIC.railTop - 0.0005, 1, -0.15, -0.05]);
    expect((rail?.max[0] ?? 0) - (rail?.min[0] ?? 0)).toBeGreaterThan(0.0145);
    expect((rail?.max[0] ?? 0) - (rail?.min[0] ?? 0)).toBeLessThan(0.0165);
  });

  it('has the muzzle anchor at the centre of the front of the suppressor, on the bore axis', () => {
    const front = crown(gun);
    expect(front.count).toBeGreaterThanOrEqual(24);
    expect(Math.abs(layout.muzzle[2] - front.z)).toBeLessThan(0.001);
    expect(Math.hypot(boreX - front.centre[0], boreY - front.centre[1])).toBeLessThan(0.001);
    // The barrel inside the handguard has the same centre.
    const across = gun.crossings('body', [boreX, boreY, -0.3], 0).filter((x) => Math.abs(x - boreX) < 0.0125);
    const upright = gun.crossings('body', [boreX, boreY, -0.3], 1).filter((y) => Math.abs(y - boreY) < 0.0125);
    expect(across.length).toBeGreaterThanOrEqual(2);
    expect(upright.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs((Math.min(...across) + Math.max(...across)) / 2 - boreX)).toBeLessThan(0.001);
    expect(Math.abs((Math.min(...upright) + Math.max(...upright)) / 2 - boreY)).toBeLessThan(0.001);
  });

  it('carries a long suppressor ahead of the handguard and nothing else there', () => {
    const ahead = gun.within('body', [-1, 1, -1, 1, -1, handguardFront - 0.015]);
    expect(ahead).not.toBeNull();
    if (!ahead) return;
    // A round can about 42 mm across, centred on the bore.
    for (const [axis, centre] of [[0, boreX], [1, boreY]] as const) {
      expect(ahead.max[axis] - centre).toBeCloseTo(0.021, 3);
      expect(centre - ahead.min[axis]).toBeCloseTo(0.021, 3);
    }
    expect(handguardFront - gun.min[2]).toBeGreaterThan(0.19);
    expect(handguardFront - gun.min[2]).toBeLessThan(0.23);
    // It starts within a centimetre of the handguard: no flash hider or long bare barrel between them.
    const gap = gun.within('body', [-1, 1, -1, 1, handguardFront - 0.01, handguardFront - 0.001]);
    expect(gap).not.toBeNull();
    expect((gap?.max[0] ?? 1) - boreX).toBeLessThan(0.022);
    expect((gap?.max[1] ?? 1) - boreY).toBeLessThan(0.022);
  });

  it('seats the optic on the top rail', () => {
    expect(M7_OPTIC.axis - M7_OPTIC.railTop).toBeCloseTo(HOLO_AXIS_HEIGHT, 4);
    expect(M7_OPTIC.rear - M7_OPTIC.window).toBeCloseTo(HOLO_BODY.rear, 6);
    const front = M7_OPTIC.window + HOLO_BODY.front;
    // The rail is under the whole length of the sight body, and its top is where the layout says.
    for (const z of [front + 0.004, (front + M7_OPTIC.rear) / 2, M7_OPTIC.rear - 0.004]) {
      const footing = gun.within('body', [-0.012, 0.012, M7_OPTIC.railTop - 0.006, M7_OPTIC.railTop + 0.02, z - 0.012, z + 0.012]);
      expect(footing, `rail at z ${z}`).not.toBeNull();
      expect(Math.abs((footing?.max[1] ?? 0) - M7_OPTIC.railTop)).toBeLessThan(0.0006);
    }
  });

  it('has a clear sight axis: nothing on the gun stands above the rail', () => {
    expect(eye.x).toBe(0);
    expect(eye.y).toBeCloseTo(M7_OPTIC.axis, 9);
    // The source's red dot is gone and there are no iron sights.
    expect(gun.max[1]).toBeLessThan(M7_OPTIC.railTop + 0.0005);
    expect(gun.crossings('body', [0, M7_OPTIC.axis, 0], 2)).toEqual([]);
    // The stock and the rear charging handle are well under the eye.
    const behind = gun.within(undefined, [-0.03, 0.03, -1, 1, eye.z - 0.08, 1]);
    expect(M7_OPTIC.axis - (behind?.max[1] ?? 1)).toBeGreaterThan(0.03);
  });

  it('has the ejection anchor at the mouth of the port, beside the bolt carrier', () => {
    const bolt = gun.within('bolt', EVERYWHERE);
    expect(bolt).not.toBeNull();
    if (!bolt) return;
    const [x, y, z] = layout.ejection;
    expect(z).toBeGreaterThan(bolt.min[2]);
    expect(z).toBeLessThan(bolt.max[2]);
    expect(y).toBeGreaterThan(bolt.min[1]);
    expect(y).toBeLessThan(bolt.max[1]);
    // The port is a real opening here: nothing of the receiver stands to the right of the carrier.
    expect(gun.crossings('body', [0, y, z], 0).filter((wall) => wall > 0)).toEqual([]);
    // The anchor is at its mouth: outside the carrier and just proud of the wall the port is cut in,
    // which is read at the same height a centimetre ahead of the port.
    expect(x).toBeGreaterThan(bolt.max[0]);
    const wall = Math.max(...gun.crossings('body', [0, y, bolt.min[2] - 0.008], 0));
    expect(x - wall).toBeGreaterThan(0);
    expect(x - wall).toBeLessThan(0.004);
  });

  // As on the M4A1, the trigger grip is the rig's hand reference point (upper palm, by the web of
  // the hand): just behind the receiver's tail, above the grip's backstrap. Checked by eye in
  // shots/guns-hands-m7-trigger.jpg.
  it('puts the trigger hand high behind the pistol grip, a finger length behind the trigger', () => {
    const [x, y, z] = layout.grips.trigger.position;
    const faces = gun.crossings('body', [0, y - 0.02, z - 0.008], 0);
    expect(faces.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(x - Math.max(...faces))).toBeLessThan(0.004);
    const rearFace = Math.max(...gun.crossings('body', [0.006, y, 0], 2).filter((face) => face < 0.05));
    expect(z - rearFace).toBeGreaterThan(0.005);
    expect(z - rearFace).toBeLessThan(0.025);
    expect(gun.crossings('body', [0.006, 0, z], 1).some((height) => height < y && height > y - 0.03)).toBe(true);
    const trigger = gun.within('trigger', EVERYWHERE);
    expect(trigger).not.toBeNull();
    if (!trigger) return;
    const reach = z - (trigger.min[2] + trigger.max[2]) / 2;
    expect(reach).toBeGreaterThan(0.05);
    expect(reach).toBeLessThan(0.09);
    expect(y).toBeGreaterThan(trigger.min[1]);
    expect(y).toBeLessThan(trigger.max[1]);
  });

  it('puts the support hand under the bare handguard, between the magazine and the suppressor', () => {
    const [x, y, z] = layout.grips.support.position;
    const undersideAt = (centre: number): number => gun.crossings('body', [x, 0, centre], 1)[0];
    const underside = undersideAt(z);
    // The palm is a few millimetres under the handguard, not inside it and not hanging below it.
    expect(underside - y).toBeGreaterThan(0);
    expect(underside - y).toBeLessThan(0.006);
    // The handguard runs level at least a palm's half width ahead of and behind the hand.
    for (const offset of [-0.045, 0.045]) expect(Math.abs(undersideAt(z + offset) - underside)).toBeLessThan(0.002);
    // The source's vertical foregrip and the rail section it sat on are gone.
    expect(gun.within('body', [-0.03, 0.03, -1, underside - 0.002, handguardFront, -0.2])).toBeNull();
    const magazine = gun.within('magazine', EVERYWHERE);
    expect((magazine?.min[2] ?? 0) - z).toBeGreaterThan(0.07);
    expect(z - handguardFront).toBeGreaterThan(0.1);
  });

  it('has every moving part as its own unrotated node with room to move', () => {
    for (const name of Object.values(layout.parts)) {
      const part = gun.parts.get(name);
      expect(part, name).toBeDefined();
      expect(part?.rotation).toEqual([0, 0, 0, 1]);
      expect(part?.scale).toEqual([1, 1, 1]);
    }
    // The carrier and the charging handle slide back by the cycle travel without leaving the gun.
    const bolt = gun.within('bolt', EVERYWHERE);
    const handle = gun.within('chargingHandle', EVERYWHERE);
    expect((bolt?.max[2] ?? 1) + layout.cycleTravel).toBeLessThan(0.02);
    expect((handle?.max[2] ?? 1) + layout.cycleTravel).toBeLessThan(gun.max[2]);
    // Pulled all the way back, the handle's bar still reaches under the rail: it does not hang loose.
    const railRear = gun.within('body', [-1, 1, M7_OPTIC.railTop - 0.001, 1, -1, 1])?.max[2] ?? 0;
    expect((handle?.min[2] ?? 1) + layout.cycleTravel).toBeLessThan(railRear - 0.02);
    // The trigger hangs from its pin: the node sits at the top of the blade.
    const trigger = gun.within('trigger', EVERYWHERE);
    expect(Math.abs((gun.parts.get('trigger')?.translation[1] ?? 0) - (trigger?.max[1] ?? 1))).toBeLessThan(0.002);
  });

  it('has a straight 20-round box magazine, not the curved 30-round one of the source', () => {
    const magazine = gun.within('magazine', EVERYWHERE);
    expect(magazine).not.toBeNull();
    if (!magazine) return;
    // The three ribs on its sides, top to bottom, by the middle of each along the barrel.
    const ribs = gun
      .pieces('magazine')
      .filter((piece) => piece.triangles === 44)
      .sort((a, b) => b.min[1] - a.min[1])
      .map((piece) => ({ y: (piece.min[1] + piece.max[1]) / 2, z: (piece.min[2] + piece.max[2]) / 2 }));
    expect(ribs).toHaveLength(3);
    const lean = (from: number, to: number): number => (ribs[to].z - ribs[from].z) / (ribs[to].y - ribs[from].y);
    // They step forward evenly on the way down (a straight box leaning a few degrees) ...
    expect(Math.abs(lean(0, 1) - lean(1, 2))).toBeLessThan(0.03);
    // ... by far less than the source's curve, which runs forward about 18 mm per 100 mm at the bottom.
    expect(lean(0, 2)).toBeGreaterThan(0.03);
    expect(lean(0, 2)).toBeLessThan(0.11);
    // It hangs about 95 mm below the lower edge of the magazine well's wall; the source's hangs 128 mm.
    const well = Math.min(...gun.crossings('body', [0.014, 0, (magazine.min[2] + magazine.max[2]) / 2], 1));
    expect(well - magazine.min[1]).toBeGreaterThan(0.085);
    expect(well - magazine.min[1]).toBeLessThan(0.1);
  });

  it('has a charging handle on the left of the upper receiver and none on the right', () => {
    const box = [0.1, 0.125, -0.19, -0.15] as const;
    const left = gun.within('body', [-0.035, -0.021, ...box]);
    expect(left).not.toBeNull();
    expect(gun.within('body', [0.021, 0.035, ...box])).toBeNull();
    // It stands 9 mm or so proud of the receiver wall and stays clear of the support hand.
    const wall = Math.min(...gun.crossings('body', [0, 0.112, -0.13], 0));
    expect(wall - (left?.min[0] ?? 0)).toBeGreaterThan(0.006);
    expect(wall - (left?.min[0] ?? 0)).toBeLessThan(0.016);
    expect((left?.min[2] ?? -1) - layout.grips.support.position[2]).toBeGreaterThan(0.1);
  });

  it('names its nine finishes and carries no textures, so no maker marks', () => {
    expect([...gun.materials].sort()).toEqual([
      'm7_black',
      'm7_bolt',
      'm7_brass',
      'm7_bullet',
      'm7_magazine',
      'm7_polymer',
      'm7_receiver',
      'm7_steel',
      'm7_suppressor',
    ]);
    expect(gun.textureTypes).toEqual([]);
  });

  it('stays small and uses nothing the loader cannot read', () => {
    expect(gun.bytes).toBeLessThan(1_000_000);
    expect(gun.triangles).toBeLessThan(25_000);
    expect(gun.extensions).toEqual([]);
  });
});
