import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { M249_LAYOUT, gripPose, sightPose } from '../../../src/weapons/models/lib/guns-c-layout';
import { crown, readGun } from './guns-c-glb';

const layout = M249_LAYOUT;

describe('M249 layout', () => {
  it('puts the eye on the line through the rear aperture and the front post', () => {
    const pose = sightPose(layout);
    const rear = new Vector3(...layout.sightRear);
    const front = new Vector3(...layout.sightFront);
    const forward = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
    expect(forward.distanceTo(front.clone().sub(rear).normalize())).toBeLessThan(1e-6);
    expect(rear.clone().sub(pose.position).normalize().distanceTo(forward)).toBeLessThan(1e-6);
    expect(pose.position.distanceTo(rear)).toBeCloseTo(layout.eyeRelief, 9);
    // The iron sights are near enough level that aiming does not tip the gun.
    expect(Math.abs(forward.y)).toBeLessThan(0.01);
    expect(forward.x).toBe(0);
  });

  it('holds the gun with the left hand under the handguard, ahead of the belt box', () => {
    expect(layout.grips.trigger.position[0]).toBeGreaterThan(0);
    expect(layout.grips.support.position[2]).toBeLessThan(-0.2);
    const support = gripPose(layout.grips.support);
    expect(new Vector3(1, 0, 0).applyQuaternion(support.quaternion).y).toBeGreaterThan(0.6);
  });
});

describe('M249 processed model', async () => {
  const gun = await readGun('m249');
  const eye = sightPose(layout).position;
  const whole = [-1, 1, -1, 1, -1, 1];

  it('is real size and points down -Z', () => {
    expect(gun.size[2]).toBeGreaterThan(layout.realLength * 0.95);
    expect(gun.size[2]).toBeLessThan(layout.realLength * 1.05);
    expect(-gun.min[2]).toBeGreaterThan(gun.max[2]);
  });

  it('has the muzzle anchor at the centre of the crown, on the bore axis', () => {
    const front = crown(gun);
    expect(front.count).toBeGreaterThanOrEqual(12);
    expect(front.radius).toBeLessThan(0.014);
    expect(Math.abs(layout.muzzle[2] - front.z)).toBeLessThan(0.001);
    expect(Math.hypot(layout.muzzle[0] - front.centre[0], layout.muzzle[1] - front.centre[1])).toBeLessThan(0.001);
    const [x, y, z] = layout.muzzle;
    const barrel = gun.within('body', [x - 0.014, x + 0.014, y - 0.014, y + 0.014, z + 0.03, z + 0.06]);
    expect(barrel).not.toBeNull();
    expect(Math.abs(((barrel?.min[0] ?? 1) + (barrel?.max[0] ?? 1)) / 2 - x)).toBeLessThan(0.001);
    expect(Math.abs(((barrel?.min[1] ?? 1) + (barrel?.max[1] ?? 1)) / 2 - y)).toBeLessThan(0.001);
  });

  it('has the rear sight point at the centre of the open aperture', () => {
    const [x, y, z] = layout.sightRear;
    const slab = gun.points('cover').filter((p) => Math.abs(p[2] - z) < 0.005);
    const distance = (p: readonly number[]): number => Math.hypot(p[0] - x, p[1] - y);
    // The rim of the hole is a ring of vertices 2.8 mm out, evenly round the point ...
    const rim = slab.filter((p) => distance(p) > 0.0025 && distance(p) < 0.0031);
    expect(rim.length).toBeGreaterThanOrEqual(16);
    expect(Math.abs(rim.reduce((sum, p) => sum + p[0], 0) / rim.length - x)).toBeLessThan(0.0003);
    expect(Math.abs(rim.reduce((sum, p) => sum + p[1], 0) / rim.length - y)).toBeLessThan(0.0003);
    // ... and nothing of the sight is inside it.
    expect(slab.filter((p) => distance(p) < 0.0024)).toEqual([]);
  });

  it('has the front sight point on the tip of the post, under its hood', () => {
    const [x, y, z] = layout.sightFront;
    // The post is its own thin piece; the hood round it is a separate, wider one.
    const posts = gun.pieces('body').filter((piece) => piece.max[2] > z - 0.03 && piece.min[2] < z + 0.03 && piece.max[0] - piece.min[0] < 0.003 && piece.max[1] > 0.14);
    expect(posts).toHaveLength(1);
    const [post] = posts;
    expect(Math.abs(post.max[1] - y)).toBeLessThan(0.0003);
    expect(Math.abs((post.min[0] + post.max[0]) / 2 - x)).toBeLessThan(0.0003);
    expect(z).toBeGreaterThan(post.min[2] - 0.001);
    expect(z).toBeLessThan(post.max[2] + 0.001);
    const hood = gun.within('body', [-0.01, 0.01, y, 1, z - 0.02, z + 0.02]);
    expect((hood?.max[1] ?? 0) - y).toBeGreaterThan(0.004);
  });

  it('has a sight line that meets only the tip of the front post', () => {
    const rear = new Vector3(...layout.sightRear);
    const front = new Vector3(...layout.sightFront);
    // The line is level to within a millimetre over its length, so it can be followed along Z.
    expect(Math.abs(front.y - rear.y)).toBeLessThan(0.001);
    const along = (height: number, node: string): number[] => gun.crossings(node, [0, height, 0], 2).filter((z) => z < eye.z);
    // A millimetre above the tip nothing is in the way from the eye to the muzzle: not the cover, the hood or the barrel.
    for (const node of ['body', 'cover', 'chargingHandle']) expect(along(front.y + 0.001, node), node).toEqual([]);
    // A millimetre below it the only thing met is the post.
    expect(along(front.y - 0.001, 'cover')).toEqual([]);
    const met = along(front.y - 0.001, 'body');
    expect(met.length).toBeGreaterThan(0);
    for (const z of met) expect(Math.abs(z - front.z)).toBeLessThan(0.003);
    // The eye is behind the rear sight and ahead of the butt.
    expect(eye.z - rear.z).toBeCloseTo(layout.eyeRelief, 3);
    expect(eye.z).toBeLessThan(gun.max[2]);
  });

  it('has the ejection anchor outside the port on the right, pointing out and down', () => {
    const [x, y, z] = layout.ejection;
    const right = (at: number): number[] => gun.crossings('body', [0, y, at], 0).filter((wall) => wall > 0);
    // The port is a recess in the right wall: the wall steps in at the anchor and is full width beyond each end.
    const recess = Math.min(...right(z));
    expect(Math.min(...right(z - 0.045)) - recess).toBeGreaterThan(0.002);
    expect(Math.min(...right(z + 0.045)) - recess).toBeGreaterThan(0.002);
    // The anchor is outside everything there (the open port cover included), by less than 15 mm.
    const outermost = Math.max(...right(z));
    expect(x - outermost).toBeGreaterThan(0.002);
    expect(x - outermost).toBeLessThan(0.015);
    expect(layout.ejectionTiltDeg).toBeLessThan(0);
    expect(layout.ejectionTiltDeg).toBeGreaterThan(-60);
  });

  // The grips are the arm rig's hand reference points, not points of contact (see m4a1.test.ts).
  it('puts the trigger hand high behind the pistol grip, a finger length behind the trigger', () => {
    const [x, y, z] = layout.grips.trigger.position;
    const faces = gun.crossings('body', [0, y - 0.02, z - 0.008], 0);
    expect(faces.length).toBeGreaterThanOrEqual(2);
    expect(Math.abs(x - Math.max(...faces))).toBeLessThan(0.004);
    const rearFace = Math.max(...gun.crossings('body', [0.006, y, 0], 2).filter((face) => face < 0.05));
    expect(z - rearFace).toBeGreaterThan(0.003);
    expect(z - rearFace).toBeLessThan(0.025);
    const trigger = gun.within('trigger', whole);
    expect(trigger).not.toBeNull();
    if (!trigger) return;
    const reach = z - (trigger.min[2] + trigger.max[2]) / 2;
    expect(reach).toBeGreaterThan(0.05);
    expect(reach).toBeLessThan(0.09);
    expect(y).toBeGreaterThan(trigger.min[1]);
    expect(y).toBeLessThan(trigger.max[1]);
  });

  // This handguard is cupped from below with the hand touching its lower edges and the bipod yoke:
  // the reference point hangs about 3 cm under the surface straight above it. Raising it buries
  // the hand in the handguard (shots/guns-arms-m249-support.jpg).
  it('puts the support hand under the handguard, ahead of the belt box', () => {
    const [x, y, z] = layout.grips.support.position;
    const underside = gun.crossings('body', [x, 0, z], 1)[0];
    expect(underside - y).toBeGreaterThan(0.02);
    expect(underside - y).toBeLessThan(0.04);
    const flanks = gun.crossings('body', [0, underside + 0.002, z], 0);
    expect(x).toBeGreaterThan(Math.min(...flanks));
    expect(x).toBeLessThan(Math.max(...flanks));
    const box = gun.within('magazine', whole);
    expect((box?.min[2] ?? 0) - z).toBeGreaterThan(0.07);
    expect(z).toBeGreaterThan(layout.sightFront[2] + 0.1);
  });

  it('has the bolt, belt box, trigger, cocking handle and feed cover as their own unrotated nodes with room to move', () => {
    expect(Object.keys(layout.parts).sort()).toEqual(['bolt', 'chargingHandle', 'cover', 'magazine', 'trigger']);
    for (const name of Object.values(layout.parts)) {
      const part = gun.parts.get(name);
      expect(part, name).toBeDefined();
      expect(part?.rotation).toEqual([0, 0, 0, 1]);
      expect(part?.scale).toEqual([1, 1, 1]);
    }
    for (const name of ['bolt', 'chargingHandle']) {
      expect((gun.within(name, whole)?.max[2] ?? 1) + layout.cycleTravel, name).toBeLessThan(gun.max[2]);
    }
  });

  it('hinges the feed cover at its front edge', () => {
    const cover = gun.parts.get('cover');
    const mesh = gun.within('cover', whole);
    expect(cover?.translation[2]).toBeLessThan(-0.15);
    expect(Math.abs((cover?.translation[2] ?? 0) - (mesh?.min[2] ?? 1))).toBeLessThan(0.02);
  });

  it('feeds from the left and ejects to the right', () => {
    expect(layout.ejection[0]).toBeGreaterThan(0);
    // The belt box hangs further out on the left than anything does on the right.
    expect(-gun.min[0]).toBeGreaterThan(0.06);
    expect(-(gun.within('magazine', whole)?.min[0] ?? 0)).toBeGreaterThan(0.06);
  });

  it('stays small and uses formats the loader can read', () => {
    expect(gun.bytes).toBeLessThan(3_000_000);
    expect(gun.triangles).toBeLessThan(40_000);
    expect(gun.textureTypes.every((type) => type === 'image/webp')).toBe(true);
    expect(gun.extensions).not.toContain('KHR_draco_mesh_compression');
    expect(gun.extensions).not.toContain('EXT_meshopt_compression');
    expect(gun.extensions).not.toContain('KHR_texture_basisu');
  });
});
