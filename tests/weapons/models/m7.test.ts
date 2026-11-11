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
  /** Front end of the handguard: its flat sides are the widest fixed surface of the gun. */
  const handguardFront = gun.within('body', [0.02245, 0.0226, -1, 1, -1, 1])?.min[2] ?? 0;

  it('is real size and points down -Z', () => {
    // 914 mm with the suppressor fitted, the published length of the issued rifle.
    expect(gun.size[2]).toBeGreaterThan(layout.realLength * 0.99);
    expect(gun.size[2]).toBeLessThan(layout.realLength * 1.01);
    expect(-gun.min[2]).toBeGreaterThan(gun.max[2]);
    expect(Math.abs(gun.min[0] + gun.max[0])).toBeLessThan(0.01);
    // The top flat of a Picatinny rail is 15.7 mm wide.
    const rail = gun.within('body', [-1, 1, M7_OPTIC.railTop - 0.0002, M7_OPTIC.railTop + 0.0002, -0.15, -0.05]);
    expect((rail?.max[0] ?? 0) - (rail?.min[0] ?? 0)).toBeGreaterThan(0.0145);
    expect((rail?.max[0] ?? 0) - (rail?.min[0] ?? 0)).toBeLessThan(0.0165);
  });

  it('has a 13 in barrel inside a handguard that stops short of the suppressor', () => {
    // From the bolt face at the front of the carrier to the end of the bare barrel under the suppressor.
    const bolt = gun.within('bolt', EVERYWHERE);
    const across = gun.crossings('body', [boreX, boreY, -0.3], 0).filter((x) => Math.abs(x - boreX) < 0.0125);
    const upright = gun.crossings('body', [boreX, boreY, -0.3], 1).filter((y) => Math.abs(y - boreY) < 0.0125);
    expect(across.length).toBeGreaterThanOrEqual(2);
    expect(upright.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs((Math.min(...across) + Math.max(...across)) / 2 - boreX)).toBeLessThan(0.001);
    expect(Math.abs((Math.min(...upright) + Math.max(...upright)) / 2 - boreY)).toBeLessThan(0.001);
    expect(handguardFront).toBeLessThan(-0.45);
    expect(handguardFront).toBeGreaterThan(-0.48);
    // 13 in is 330 mm; the barrel ends a little inside the suppressor.
    const barrelEnd = handguardFront - 0.03;
    expect((bolt?.min[2] ?? 0) - barrelEnd).toBeGreaterThan(0.31);
    expect((bolt?.min[2] ?? 0) - barrelEnd).toBeLessThan(0.35);
  });

  it('has the muzzle anchor at the centre of the front of the suppressor, on the bore axis', () => {
    const front = crown(gun);
    expect(front.count).toBeGreaterThanOrEqual(24);
    expect(Math.abs(layout.muzzle[2] - front.z)).toBeLessThan(0.001);
    expect(Math.hypot(boreX - front.centre[0], boreY - front.centre[1])).toBeLessThan(0.001);
  });

  it('carries the suppressor ahead of the handguard: a locking ring, then a plain body', () => {
    const ahead = gun.within('body', [-1, 1, -1, 1, -1, handguardFront - 0.012]);
    expect(ahead).not.toBeNull();
    if (!ahead) return;
    // Nothing but round parts on the bore axis, the widest of them the 41 mm ring.
    for (const [axis, centre] of [[0, boreX], [1, boreY]] as const) {
      expect(ahead.max[axis] - centre).toBeGreaterThan(0.0198);
      expect(ahead.max[axis] - centre).toBeLessThan(0.0212);
      expect(centre - ahead.min[axis]).toBeLessThan(0.0212);
    }
    // The body is a little slimmer than the ring: 39 mm.
    const body = gun.within('body', [-1, 1, -1, 1, -1, handguardFront - 0.06]);
    expect((body?.max[0] ?? 0) - boreX).toBeGreaterThan(0.0188);
    expect((body?.max[0] ?? 0) - boreX).toBeLessThan(0.02);
    expect(handguardFront - gun.min[2]).toBeGreaterThan(0.15);
    expect(handguardFront - gun.min[2]).toBeLessThan(0.19);
  });

  it('seats the optic on the receiver rail', () => {
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

  it('has a clear sight axis over the folded back-up sights', () => {
    expect(eye.x).toBe(0);
    expect(eye.y).toBeCloseTo(M7_OPTIC.axis, 9);
    expect(gun.crossings('body', [0, M7_OPTIC.axis, 0], 2)).toEqual([]);
    // The folded sights are the highest things on the gun and stay 3 cm under the axis.
    expect(gun.max[1]).toBeGreaterThan(M7_OPTIC.railTop + 0.005);
    expect(M7_OPTIC.axis - gun.max[1]).toBeGreaterThan(0.03);
    // Neither sits where the optic does.
    const underOptic = gun.within('body', [-1, 1, M7_OPTIC.railTop + 0.001, 1, M7_OPTIC.window + HOLO_BODY.front - 0.005, M7_OPTIC.rear + 0.005]);
    expect(underOptic).toBeNull();
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
    // The anchor is just proud of the wall the port is cut in, read on the flank above the port's lip.
    expect(x).toBeGreaterThan(bolt.max[0]);
    const wall = Math.max(...gun.crossings('body', [0, 0.12, z], 0));
    expect(x - wall).toBeGreaterThan(0);
    expect(x - wall).toBeLessThan(0.004);
  });

  // As on the M4A1, the trigger grip is the rig's hand reference point (upper palm, by the web of
  // the hand), not a point of contact. Checked by eye in shots/guns-hands-m7-trigger.jpg.
  it('puts the trigger hand high behind the pistol grip, a finger length behind the trigger', () => {
    const [x, y, z] = layout.grips.trigger.position;
    const faces = gun.crossings('body', [0, y - 0.03, z - 0.02], 0);
    expect(faces.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(x - Math.max(...faces))).toBeLessThan(0.004);
    const trigger = gun.within('trigger', EVERYWHERE);
    expect(trigger).not.toBeNull();
    if (!trigger) return;
    const reach = z - (trigger.min[2] + trigger.max[2]) / 2;
    expect(reach).toBeGreaterThan(0.05);
    expect(reach).toBeLessThan(0.09);
    // Level with the blade, so the index finger lies along the frame onto it.
    expect(y).toBeGreaterThan(trigger.min[1]);
    expect(y).toBeLessThan(trigger.max[1]);
  });

  it('puts the support hand under the handguard, between the magazine and the suppressor', () => {
    const [, y, z] = layout.grips.support.position;
    // Read beside the row of slots along the bottom.
    const undersideAt = (centre: number): number => gun.crossings('body', [0.008, 0, centre], 1)[0];
    const underside = undersideAt(z);
    // The palm is a few millimetres under the handguard, not inside it and not hanging below it.
    expect(underside - y).toBeGreaterThan(0);
    expect(underside - y).toBeLessThan(0.006);
    for (const offset of [-0.045, 0.045]) expect(Math.abs(undersideAt(z + offset) - underside)).toBeLessThan(0.002);
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
    const receiverRear = Math.max(...gun.crossings('body', [0.017, 0.1, 0], 2).filter((z) => z < 0.066));
    // The carrier slides back by the cycle travel and stays inside the receiver.
    const bolt = gun.within('bolt', EVERYWHERE);
    expect((bolt?.max[2] ?? 1) + layout.cycleTravel).toBeLessThan(receiverRear - 0.01);
    // It fills the ejection port when forward and clears most of it when back.
    expect(bolt?.min[2] ?? 0).toBeLessThan(layout.ejection[2] - 0.04);
    expect((bolt?.min[2] ?? 0) + layout.cycleTravel).toBeGreaterThan(layout.ejection[2]);
    // The rear charging handle draws back over the stock's strut, its bar still under the rail.
    const handle = gun.within('chargingHandle', EVERYWHERE);
    expect((handle?.max[2] ?? 1) + layout.cycleTravel).toBeLessThan(gun.max[2]);
    const railRear = gun.within('body', [-1, 1, M7_OPTIC.railTop - 0.0002, M7_OPTIC.railTop + 0.0002, -1, 1])?.max[2] ?? 0;
    expect((handle?.min[2] ?? 1) + layout.cycleTravel).toBeLessThan(railRear - 0.02);
    // The trigger hangs from its pin: the node sits at the top of the blade.
    const trigger = gun.within('trigger', EVERYWHERE);
    expect(Math.abs((gun.parts.get('trigger')?.translation[1] ?? 0) - (trigger?.max[1] ?? 1))).toBeLessThan(0.002);
  });

  it('has a raked pistol grip and a magazine well deeper than the trigger housing', () => {
    // The grip leans back about 18 degrees: its back strap is some 20 mm further back at the bottom than at the top.
    const backAt = (y: number): number => Math.max(...gun.crossings('body', [0, y, 0], 2).filter((z) => z < 0.05));
    expect(backAt(-0.03) - backAt(0.03)).toBeGreaterThan(0.015);
    expect(backAt(-0.03) - backAt(0.03)).toBeLessThan(0.03);
    // Underside of the trigger housing, and of the magazine well at its middle.
    const housing = Math.min(...gun.crossings('body', [0.012, 0, -0.07], 1).filter((y) => y > 0.035));
    const well = Math.min(...gun.crossings('body', [0.016, 0, -0.126], 1));
    expect(housing - well).toBeGreaterThan(0.012);
  });

  it('has a straight 20-round magazine of SR-25 size with a cartridge at the top', () => {
    const magazine = gun.within('magazine', EVERYWHERE);
    expect(magazine).not.toBeNull();
    if (!magazine) return;
    /** Front and rear faces of the box at a height, read beside the spine. */
    const depthAt = (y: number): number[] => gun.crossings('magazine', [0.008, y, 0], 2);
    const [front, rear] = [Math.min(...depthAt(-0.02)), Math.max(...depthAt(-0.02))];
    // About 71 mm front to back and 26 mm wide; an AR-15 magazine is 61 mm by 22 mm.
    expect(rear - front).toBeGreaterThan(0.068);
    expect(rear - front).toBeLessThan(0.076);
    const sides = gun.crossings('magazine', [0, -0.02, (front + rear) / 2], 0);
    expect(Math.max(...sides) - Math.min(...sides)).toBeGreaterThan(0.025);
    expect(Math.max(...sides) - Math.min(...sides)).toBeLessThan(0.028);
    // Straight: the same section near the bottom as near the well.
    expect(Math.abs(Math.min(...depthAt(-0.03)) - front)).toBeLessThan(0.001);
    expect(Math.abs(Math.min(...depthAt(0.015)) - front)).toBeLessThan(0.001);
    // It hangs about 70 mm below the mouth of the well.
    const mouth = Math.min(...gun.crossings('body', [0.016, 0, (front + rear) / 2], 1));
    expect(mouth - magazine.min[1]).toBeGreaterThan(0.06);
    expect(mouth - magazine.min[1]).toBeLessThan(0.085);
    // The top cartridge lies along the bore, about 70 mm long, above the feed lips.
    const cartridge = gun.pieces('magazine').filter((piece) => piece.min[1] > 0.08 && piece.max[2] - piece.min[2] > 0.045 && piece.max[0] - piece.min[0] < 0.013);
    expect(cartridge).toHaveLength(1);
  });

  it('has the folded charging handle on the left of the receiver only', () => {
    const box = [0.09, 0.115, -0.245, -0.195] as const;
    expect(gun.within('body', [-0.035, -0.0235, ...box])).not.toBeNull();
    expect(gun.within('body', [0.0235, 0.035, ...box])).toBeNull();
    // Its slot is cut into the left flank under the rail.
    const left = Math.min(...gun.crossings('body', [0, 0.123, -0.1], 0));
    const right = Math.max(...gun.crossings('body', [0, 0.123, -0.1], 0));
    expect(right + left).toBeGreaterThan(0.0008);
  });

  it('names its three texture sets', () => {
    expect([...gun.materials].sort()).toEqual(['m7_furniture', 'm7_receiver', 'm7_steel']);
    // Base colour, normal and packed occlusion / roughness / metalness for each.
    expect(gun.textureTypes).toHaveLength(9);
    expect(gun.textureTypes.every((type) => type === 'image/webp')).toBe(true);
  });

  it('is detailed, and still small enough to download', () => {
    expect(gun.triangles).toBeGreaterThan(60_000);
    expect(gun.triangles).toBeLessThan(90_000);
    expect(gun.bytes).toBeLessThan(5_500_000);
    expect(gun.extensions).not.toContain('KHR_draco_mesh_compression');
    expect(gun.extensions).not.toContain('EXT_meshopt_compression');
    expect(gun.extensions).not.toContain('KHR_texture_basisu');
  });
});
