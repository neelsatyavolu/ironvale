import { Quaternion, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { M4A1_LAYOUT, M4A1_OPTIC, gripPose, sightPose } from '../../../src/weapons/models/lib/guns-c-layout';
import { HOLO_AXIS_HEIGHT, HOLO_BODY, HOLO_WINDOW } from '../../../src/weapons/models/lib/guns-c-optic';
import { crown, readGun } from './guns-c-glb';

const layout = M4A1_LAYOUT;

describe('M4A1 layout', () => {
  it('puts the eye on the optic axis, looking straight down -Z', () => {
    const pose = sightPose(layout);
    const forward = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
    expect(forward.x).toBeCloseTo(0, 9);
    expect(forward.y).toBeCloseTo(0, 9);
    expect(forward.z).toBeCloseTo(-1, 9);
    expect(pose.position.x).toBe(0);
    expect(pose.position.y).toBeCloseTo(M4A1_OPTIC.axis, 9);
  });

  it('keeps the eye far enough behind the sight body that the 4 cm near plane cannot cut into it', () => {
    const pose = sightPose(layout);
    expect(pose.position.z - M4A1_OPTIC.rear).toBeGreaterThan(0.06);
    expect(pose.position.z).toBeLessThan(0.12);
  });

  it('rejects sights listed back to front', () => {
    expect(() => sightPose({ sightRear: [0, 0, -1], sightFront: [0, 0, 0], eyeRelief: 0.2 })).toThrow();
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

  it('rejects a grip whose thumb is parallel to its fingers', () => {
    expect(() => gripPose({ position: [0, 0, 0], fingers: [0, 0, -1], thumb: [0, 0, 2] })).toThrow();
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

describe('M4A1 processed model', async () => {
  const gun = await readGun('m4a1');
  const eye = sightPose(layout).position;
  /** The front sight base: the piece of the body that stands above the handguard ahead of it. */
  const frontSight = gun.pieces('body').filter((piece) => piece.min[2] > -0.42 && piece.max[2] < -0.34 && piece.max[1] > 0.15);

  it('is real size and points down -Z', () => {
    expect(gun.size[2]).toBeGreaterThan(layout.realLength * 0.97);
    expect(gun.size[2]).toBeLessThan(layout.realLength * 1.03);
    expect(-gun.min[2]).toBeGreaterThan(gun.max[2]);
    expect(Math.abs(gun.min[0] + gun.max[0])).toBeLessThan(0.01);
  });

  it('has the muzzle anchor at the centre of the crown, on the bore axis', () => {
    const front = crown(gun);
    expect(front.count).toBeGreaterThanOrEqual(12);
    // The frontmost ring is the barrel, not a sling loop or a sight.
    expect(front.radius).toBeLessThan(0.012);
    expect(Math.abs(layout.muzzle[2] - front.z)).toBeLessThan(0.001);
    expect(Math.hypot(layout.muzzle[0] - front.centre[0], layout.muzzle[1] - front.centre[1])).toBeLessThan(0.001);
    // A section of bare barrel further back has the same centre.
    const [x, y, z] = layout.muzzle;
    const barrel = gun.within('body', [x - 0.012, x + 0.012, y - 0.012, y + 0.012, z + 0.06, z + 0.1]);
    expect(barrel).not.toBeNull();
    expect(Math.abs(((barrel?.min[0] ?? 1) + (barrel?.max[0] ?? 1)) / 2 - x)).toBeLessThan(0.001);
    expect(Math.abs(((barrel?.min[1] ?? 1) + (barrel?.max[1] ?? 1)) / 2 - y)).toBeLessThan(0.001);
  });

  it('seats the optic on the flat-top rail', () => {
    expect(M4A1_OPTIC.axis - M4A1_OPTIC.railTop).toBeCloseTo(HOLO_AXIS_HEIGHT, 4);
    expect(M4A1_OPTIC.rear - M4A1_OPTIC.window).toBeCloseTo(HOLO_BODY.rear, 6);
    const front = M4A1_OPTIC.window + HOLO_BODY.front;
    // The rail is under the whole length of the sight body, and its top is where the layout says.
    for (const z of [front + 0.004, (front + M4A1_OPTIC.rear) / 2, M4A1_OPTIC.rear - 0.004]) {
      const footing = gun.within('body', [-0.012, 0.012, M4A1_OPTIC.railTop - 0.006, M4A1_OPTIC.railTop + 0.02, z - 0.012, z + 0.012]);
      expect(footing, `rail at z ${z}`).not.toBeNull();
      expect(Math.abs((footing?.max[1] ?? 0) - M4A1_OPTIC.railTop)).toBeLessThan(0.0006);
    }
  });

  it('has a clear sight axis with the fixed front sight in the lower part of the window', () => {
    expect(eye.x).toBe(0);
    expect(eye.y).toBeCloseTo(M4A1_OPTIC.axis, 9);
    // Nothing on the gun crosses the axis ahead of the eye.
    expect(gun.crossings('body', [0, M4A1_OPTIC.axis, 0], 2).filter((z) => z < eye.z)).toEqual([]);
    // Nor comes within 4 mm of it between the window and the muzzle.
    const near = gun.within(undefined, [-0.004, 0.004, M4A1_OPTIC.axis - 0.004, M4A1_OPTIC.axis + 0.004, gun.min[2], M4A1_OPTIC.window]);
    expect(near).toBeNull();

    expect(frontSight).toHaveLength(1);
    const [base] = frontSight;
    // The ears stand just under the axis ...
    expect(M4A1_OPTIC.axis - base.max[1]).toBeGreaterThan(0.004);
    expect(M4A1_OPTIC.axis - base.max[1]).toBeLessThan(0.01);
    // ... and the post between them is lower, and still inside the window as the eye sees it.
    const post = gun.within('body', [-0.0015, 0.0015, 0.13, 1, base.min[2], base.max[2]]);
    expect(post).not.toBeNull();
    const tip = post?.max[1] ?? 0;
    expect(tip).toBeLessThan(base.max[1] - 0.004);
    const tipAngle = (M4A1_OPTIC.axis - tip) / (eye.z - (base.min[2] + base.max[2]) / 2);
    const windowEdgeAngle = HOLO_WINDOW.height / 2 / (eye.z - M4A1_OPTIC.window);
    expect(tipAngle).toBeLessThan(windowEdgeAngle * 0.6);
  });

  it('has the ejection anchor at the mouth of the port, beside the bolt carrier', () => {
    const bolt = gun.within('bolt', [-1, 1, -1, 1, -1, 1]);
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

  // The trigger grip is the rig's hand reference point (upper palm, by the web of the hand), not a
  // point of contact: on a rifle it sits just behind the receiver's tail, above the grip's backstrap.
  // Checked by eye in shots/guns-arms-grip.jpg; a point on the grip itself drops the hand 3 cm.
  it('puts the trigger hand high behind the pistol grip, a finger length behind the trigger', () => {
    const [x, y, z] = layout.grips.trigger.position;
    // Right of centre by about the grip's half width, read just below the anchor where the grip is solid.
    const faces = gun.crossings('body', [0, y - 0.02, z - 0.008], 0);
    expect(faces.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(x - Math.max(...faces))).toBeLessThan(0.004);
    // Behind the rear face of the receiver at its own height, by less than the thickness of a hand.
    const rearFace = Math.max(...gun.crossings('body', [0.006, y, 0], 2).filter((face) => face < 0.05));
    expect(z - rearFace).toBeGreaterThan(0.005);
    expect(z - rearFace).toBeLessThan(0.025);
    // Above the backstrap: straight down from the anchor is the grip.
    expect(gun.crossings('body', [0.006, 0, z], 1).some((height) => height < y && height > y - 0.03)).toBe(true);
    const trigger = gun.within('trigger', [-1, 1, -1, 1, -1, 1]);
    expect(trigger).not.toBeNull();
    if (!trigger) return;
    const reach = z - (trigger.min[2] + trigger.max[2]) / 2;
    expect(reach).toBeGreaterThan(0.05);
    expect(reach).toBeLessThan(0.09);
    // Level with the trigger blade, so the index finger lies along the frame onto it.
    expect(y).toBeGreaterThan(trigger.min[1]);
    expect(y).toBeLessThan(trigger.max[1]);
  });

  it('puts the support hand under the handguard, clear of the front sight base', () => {
    const [x, y, z] = layout.grips.support.position;
    // The underside is a toothed rail: take the teeth, the lowest surface over one pitch of it.
    const undersideAt = (centre: number): number =>
      Math.min(...[-0.006, -0.004, -0.002, 0, 0.002, 0.004, 0.006].map((offset) => gun.crossings('body', [x, 0, centre + offset], 1)[0]));
    const underside = undersideAt(z);
    // The palm is a few millimetres under the teeth, not inside the rail and not hanging below it.
    expect(underside - y).toBeGreaterThan(0);
    expect(underside - y).toBeLessThan(0.006);
    // The handguard runs at least a palm's half width ahead of and behind the hand.
    for (const offset of [-0.045, 0.045]) expect(Math.abs(undersideAt(z + offset) - underside)).toBeLessThan(0.002);
    expect(frontSight).toHaveLength(1);
    expect(z - frontSight[0].max[2]).toBeGreaterThan(0.07);
  });

  it('has every moving part as its own unrotated node with room to move', () => {
    for (const name of Object.values(layout.parts)) {
      const part = gun.parts.get(name);
      expect(part, name).toBeDefined();
      expect(part?.rotation).toEqual([0, 0, 0, 1]);
      expect(part?.scale).toEqual([1, 1, 1]);
    }
    // The carrier and the charging handle slide back by the cycle travel without leaving the gun.
    const bolt = gun.within('bolt', [-1, 1, -1, 1, -1, 1]);
    const handle = gun.within('chargingHandle', [-1, 1, -1, 1, -1, 1]);
    expect((bolt?.max[2] ?? 1) + layout.cycleTravel).toBeLessThan(0.02);
    expect((handle?.max[2] ?? 1) + layout.cycleTravel).toBeLessThan(gun.max[2]);
    // Pulled all the way back, the charging handle still reaches into the receiver: it is a bar, not a loose tab.
    const receiverRear = Math.max(...gun.crossings('body', [0, M4A1_OPTIC.railTop - 0.004, 0], 2).filter((z) => z < 0.05));
    expect((handle?.min[2] ?? 1) + layout.cycleTravel).toBeLessThan(receiverRear - 0.02);
    // The trigger hangs from its pin: the node sits at the top of the blade.
    const trigger = gun.within('trigger', [-1, 1, -1, 1, -1, 1]);
    expect(Math.abs((gun.parts.get('trigger')?.translation[1] ?? 0) - (trigger?.max[1] ?? 1))).toBeLessThan(0.002);
  });

  it('carries no carry handle or loose cartridge, and names its three finishes', () => {
    expect(gun.max[1]).toBeLessThan(M4A1_OPTIC.railTop + 0.04);
    expect([...gun.materials].sort()).toEqual(['m4a1_magazine', 'm4a1_metal', 'm4a1_stock']);
  });

  it('stays small and uses formats the loader can read', () => {
    expect(gun.bytes).toBeLessThan(3_000_000);
    expect(gun.triangles).toBeLessThan(25_000);
    expect(gun.textureTypes.every((type) => type === 'image/webp')).toBe(true);
    expect(gun.extensions).not.toContain('KHR_draco_mesh_compression');
    expect(gun.extensions).not.toContain('EXT_meshopt_compression');
    expect(gun.extensions).not.toContain('KHR_texture_basisu');
  });
});
