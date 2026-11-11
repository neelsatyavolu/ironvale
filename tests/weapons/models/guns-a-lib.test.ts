/** Tests for the helpers behind the mp5 gun module (src/weapons/models/lib/guns-a-assemble.ts). */
import { Group, Object3D, Quaternion, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { assembleGun, gripBasis, sightPose, type GunLayout } from '../../../src/weapons/models/lib/guns-a-assemble';

const forwardOf = (object: Object3D) => new Vector3(0, 0, -1).applyQuaternion(object.getWorldQuaternion(new Quaternion()));
const axisOf = (object: Object3D, axis: Vector3) => axis.clone().applyQuaternion(object.getWorldQuaternion(new Quaternion()));

/** Distance from `point` to the line through `origin` along unit `direction`. */
function distanceToLine(point: Vector3, origin: Vector3, direction: Vector3): number {
  const offset = point.clone().sub(origin);
  return offset.sub(direction.clone().multiplyScalar(offset.dot(direction))).length();
}

function fakeScene(): Group {
  const scene = new Group();
  const add = (name: string, x: number, y: number, z: number) => {
    const node = new Object3D();
    node.name = name;
    node.position.set(x, y, z);
    scene.add(node);
    return node;
  };
  add('part_frame', 0, 0, 0);
  add('part_slide', 0, 0, 0);
  add('part_magazine', 0, 0.05, -0.01);
  add('part_trigger', 0, 0.02, -0.05);
  add('anchor_muzzle', 0, 0.06, -0.18);
  add('anchor_ejection', 0.012, 0.065, -0.05);
  add('anchor_sight_front', 0, 0.078, -0.16);
  add('anchor_sight_rear', 0, 0.081, 0);
  return scene;
}

const layout: GunLayout = {
  parts: { slide: 'part_slide', magazine: 'part_magazine', trigger: 'part_trigger' },
  cycleTravel: 0.05,
  eyeRelief: 0.4,
  ejectionTiltDeg: 25,
  grips: {
    trigger: { position: [0.016, 0, 0], fingers: [0, 0, -1], thumb: [0, 1, 0] },
    support: { position: [-0.03, -0.01, -0.02], fingers: [1, 0.2, 0], thumb: [0, 0, -1], on: 'slide' },
  },
};

describe('sightPose', () => {
  const rear = new Vector3(0.001, 0.081, 0);
  const front = new Vector3(0, 0.078, -0.16);

  it('puts the eye behind the rear sight by the eye relief, on the line through both sights', () => {
    const pose = sightPose(rear, front, 0.4);
    expect(pose.position.distanceTo(rear)).toBeCloseTo(0.4, 6);
    const direction = front.clone().sub(rear).normalize();
    expect(distanceToLine(pose.position, rear, direction)).toBeLessThan(1e-9);
    expect(pose.position.z).toBeGreaterThan(rear.z);
  });

  it('looks down -Z through both sights with no roll', () => {
    const pose = sightPose(rear, front, 0.3);
    const forward = new Vector3(0, 0, -1).applyQuaternion(pose.quaternion);
    expect(distanceToLine(rear, pose.position, forward)).toBeLessThan(1e-9);
    expect(distanceToLine(front, pose.position, forward)).toBeLessThan(1e-9);
    const right = new Vector3(1, 0, 0).applyQuaternion(pose.quaternion);
    expect(right.y).toBeCloseTo(0, 9);
  });

  it('rejects sights that do not point down the barrel', () => {
    expect(() => sightPose(front, rear, 0.3)).toThrow(/front sight/);
  });
});

describe('gripBasis', () => {
  it('maps -Z to the fingers and +Y toward the thumb', () => {
    const q = gripBasis([1, 0, 0], [0, 0, -1]);
    expect(new Vector3(0, 0, -1).applyQuaternion(q).distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-9);
    expect(new Vector3(0, 1, 0).applyQuaternion(q).distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-9);
  });

  it('squares up a thumb direction that is not perpendicular to the fingers', () => {
    const q = gripBasis([0, 0, -2], [0, 1, -1]);
    expect(new Vector3(0, 0, -1).applyQuaternion(q).distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-9);
    expect(new Vector3(0, 1, 0).applyQuaternion(q).distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-9);
  });

  it('rejects a thumb parallel to the fingers', () => {
    expect(() => gripBasis([0, 0, -1], [0, 0, 1])).toThrow(/parallel/);
  });
});

describe('assembleGun', () => {
  it('exposes the named parts with an identity rest pose and unchanged world position', () => {
    const gun = assembleGun(fakeScene(), layout);
    gun.root.updateMatrixWorld(true);
    const magazine = gun.parts.magazine!;
    expect(magazine.position.length()).toBe(0);
    expect(magazine.quaternion.equals(new Quaternion())).toBe(true);
    expect(magazine.getWorldPosition(new Vector3()).distanceTo(new Vector3(0, 0.05, -0.01))).toBeLessThan(1e-9);
    expect(gun.parts.slide).toBeDefined();
    expect(gun.parts.trigger).toBeDefined();
    expect(gun.parts.bolt).toBeUndefined();
    expect(gun.cycleTravel).toBe(0.05);
  });

  it('places muzzle and ejection anchors, with ejection +X to the right and tilted up', () => {
    const gun = assembleGun(fakeScene(), layout);
    gun.root.updateMatrixWorld(true);
    expect(gun.muzzle.getWorldPosition(new Vector3()).distanceTo(new Vector3(0, 0.06, -0.18))).toBeLessThan(1e-9);
    const out = axisOf(gun.ejection, new Vector3(1, 0, 0));
    expect(out.x).toBeCloseTo(Math.cos((25 * Math.PI) / 180), 6);
    expect(out.y).toBeCloseTo(Math.sin((25 * Math.PI) / 180), 6);
  });

  it('aims the sight anchor through both sights', () => {
    const gun = assembleGun(fakeScene(), layout);
    gun.root.updateMatrixWorld(true);
    const eye = gun.sight.getWorldPosition(new Vector3());
    const forward = forwardOf(gun.sight);
    expect(distanceToLine(new Vector3(0, 0.081, 0), eye, forward)).toBeLessThan(1e-9);
    expect(distanceToLine(new Vector3(0, 0.078, -0.16), eye, forward)).toBeLessThan(1e-9);
    expect(eye.distanceTo(new Vector3(0, 0.081, 0))).toBeCloseTo(0.4, 6);
  });

  it('keeps moving anchors attached to their part', () => {
    const gun = assembleGun(fakeScene(), layout);
    const slide = gun.parts.slide!;
    gun.root.updateMatrixWorld(true);
    const before = {
      support: gun.grips.support.getWorldPosition(new Vector3()),
      trigger: gun.grips.trigger.getWorldPosition(new Vector3()),
    };
    slide.position.z = gun.cycleTravel;
    gun.root.updateMatrixWorld(true);
    expect(gun.grips.support.getWorldPosition(new Vector3()).z - before.support.z).toBeCloseTo(0.05, 9);
    expect(gun.grips.trigger.getWorldPosition(new Vector3()).z - before.trigger.z).toBeCloseTo(0, 9);
  });

  it('orients the grips from finger and thumb directions', () => {
    const gun = assembleGun(fakeScene(), layout);
    gun.root.updateMatrixWorld(true);
    expect(forwardOf(gun.grips.trigger).distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-9);
    const fingers = forwardOf(gun.grips.support);
    expect(fingers.distanceTo(new Vector3(1, 0.2, 0).normalize())).toBeLessThan(1e-9);
    expect(gun.grips.trigger.getWorldPosition(new Vector3()).x).toBeCloseTo(0.016, 9);
  });

  it('names the missing node when the model lacks a part or anchor', () => {
    const scene = fakeScene();
    scene.remove(scene.getObjectByName('part_magazine')!);
    expect(() => assembleGun(scene, layout)).toThrow(/part_magazine/);
    const second = fakeScene();
    second.remove(second.getObjectByName('anchor_muzzle')!);
    expect(() => assembleGun(second, layout)).toThrow(/anchor_muzzle/);
  });
});
