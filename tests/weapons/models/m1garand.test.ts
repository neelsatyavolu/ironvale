import * as THREE from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GunModel } from '../../../src/game/contracts';
import { alignSights, directionFrame, gripFrame } from '../../../src/weapons/models/lib/guns-b-rig';
import garand, { GARAND_SIGHTS } from '../../../src/weapons/models/m1garand.gun';
import { loadGunFile, surfacePoints, worldAxis, worldPoint, worldVertices, type GunFile } from './m1garand-m24.fixture';

describe('alignSights', () => {
  it('leaves a sight line that already runs down -Z untouched', () => {
    const solution = alignSights(new THREE.Vector3(0, 0.1, -0.1), new THREE.Vector3(0, 0.1, -0.8), 0.3);
    expect(solution.tilt.angleTo(new THREE.Quaternion())).toBeCloseTo(0, 9);
    expect(solution.eye.toArray()).toEqual([0, 0.1, expect.closeTo(0.2, 9)]);
  });

  it('tilts the gun so a rising, skewed sight line ends up parallel to -Z', () => {
    const rear = new THREE.Vector3(0.001, 0.09, -0.12);
    const front = new THREE.Vector3(-0.002, 0.1, -0.83);
    const { tilt, eye } = alignSights(rear, front, 0.25);
    const rearOut = rear.clone().applyQuaternion(tilt);
    const frontOut = front.clone().applyQuaternion(tilt);
    expect(frontOut.x).toBeCloseTo(rearOut.x, 9);
    expect(frontOut.y).toBeCloseTo(rearOut.y, 9);
    expect(frontOut.z).toBeLessThan(rearOut.z);
    expect(eye.x).toBeCloseTo(rearOut.x, 9);
    expect(eye.y).toBeCloseTo(rearOut.y, 9);
    expect(eye.z - rearOut.z).toBeCloseTo(0.25, 9);
  });

  it('rejects a sight line that points backwards or has no length', () => {
    const point = new THREE.Vector3(0, 0.1, -0.1);
    expect(() => alignSights(point, point.clone(), 0.3)).toThrow(/sight/i);
    expect(() => alignSights(point, new THREE.Vector3(0, 0.1, 0.5), 0.3)).toThrow(/sight/i);
  });
});

describe('directionFrame', () => {
  it('returns a rotation whose +X is the given direction', () => {
    const direction = new THREE.Vector3(0.7, 0.6, -0.2);
    const axis = new THREE.Vector3(1, 0, 0).applyQuaternion(directionFrame(direction));
    expect(axis.distanceTo(direction.clone().normalize())).toBeCloseTo(0, 9);
  });
});

describe('gripFrame', () => {
  it('points -Z along the fingers and +Y toward the thumb, squared up', () => {
    const frame = gripFrame([1, 0.5, 0], [0, 0.2, -1]);
    const fingers = new THREE.Vector3(0, 0, -1).applyQuaternion(frame);
    const thumb = new THREE.Vector3(0, 1, 0).applyQuaternion(frame);
    expect(fingers.distanceTo(new THREE.Vector3(1, 0.5, 0).normalize())).toBeCloseTo(0, 9);
    expect(thumb.dot(fingers)).toBeCloseTo(0, 9);
    expect(thumb.z).toBeLessThan(-0.9);
    expect(thumb.length()).toBeCloseTo(1, 9);
  });

  it('rejects a thumb that runs along the fingers', () => {
    expect(() => gripFrame([0, 0, -1], [0, 0, -2])).toThrow(/thumb/i);
  });
});

describe('m1garand.glb', () => {
  let file: GunFile;
  beforeAll(async () => {
    file = await loadGunFile('m1garand.glb', 'mdl-gun-m1garand');
  });

  it('is small and uses only formats the loader can decode', () => {
    expect(file.bytes).toBeLessThan(3_000_000);
    expect(file.triangles).toBeGreaterThan(10_000);
    expect(file.triangles).toBeLessThan(30_000);
    expect(file.extensions).toEqual(['EXT_texture_webp']);
    expect(new Set(file.textureTypes)).toEqual(new Set(['image/webp']));
    expect(Math.max(...file.textureSizes)).toBeLessThanOrEqual(2048);
  });

  it('has the moving parts as separate nodes', () => {
    const names = file.document.getRoot().listNodes().map((node) => node.getName());
    expect(names).toEqual(expect.arrayContaining(['body', 'bolt', 'trigger', 'clip_mount', 'clip', 'clip_steel', 'clip_rounds']));
  });
});

describe('m1garand gun module', () => {
  let file: GunFile;
  let model: GunModel;
  let bounds: THREE.Box3;
  beforeAll(async () => {
    file = await loadGunFile('m1garand.glb', 'mdl-gun-m1garand');
    model = garand.build(file.assets);
    model.root.updateMatrixWorld(true);
    bounds = new THREE.Box3().setFromObject(model.root, true);
  });

  it('declares its weapon and asset', () => {
    expect(garand.weaponId).toBe('m1garand');
    expect(garand.assets).toEqual(['mdl-gun-m1garand']);
  });

  it('is a full-size M1 with the barrel along -Z and the origin at the grip', () => {
    const size = bounds.getSize(new THREE.Vector3());
    expect(size.z).toBeGreaterThan(1.08);
    expect(size.z).toBeLessThan(1.12);
    expect(size.x).toBeLessThan(0.09);
    expect(size.y).toBeLessThan(0.22);
    // More rifle in front of the grip than behind it, and the grip sits inside the stock.
    expect(-bounds.min.z).toBeGreaterThan(0.8);
    expect(bounds.max.z).toBeGreaterThan(0.2);
    expect(bounds.max.z).toBeLessThan(0.3);
  });

  it('puts the muzzle anchor on the crown', () => {
    const muzzle = worldPoint(model.muzzle);
    expect(muzzle.z).toBeCloseTo(bounds.min.z, 2);
    expect(Math.abs(muzzle.x)).toBeLessThan(0.002);
    expect(muzzle.y).toBeGreaterThan(0.04);
    expect(muzzle.y).toBeLessThan(0.09);
  });

  it('lines the rear aperture and front blade up exactly on the sight axis', () => {
    const mesh = model.root.getObjectByName('m1garand-mesh');
    if (!mesh) throw new Error('mesh group missing');
    const eye = worldPoint(model.sight);
    const rear = worldPoint(mesh, new THREE.Vector3(...GARAND_SIGHTS.rear));
    const front = worldPoint(mesh, new THREE.Vector3(...GARAND_SIGHTS.front));
    for (const point of [rear, front]) {
      expect(point.x).toBeCloseTo(eye.x, 5);
      expect(point.y).toBeCloseTo(eye.y, 5);
    }
    expect(front.z).toBeLessThan(rear.z);
    expect(eye.z - rear.z).toBeGreaterThanOrEqual(0.25);
    expect(eye.z - rear.z).toBeLessThanOrEqual(0.4);
    expect(worldAxis(model.sight, new THREE.Vector3(0, 0, -1)).z).toBeCloseTo(-1, 9);
    expect(model.sight.parent).toBe(model.root);
  });

  it('ejects to the right', () => {
    const direction = worldAxis(model.ejection, new THREE.Vector3(1, 0, 0));
    expect(direction.x).toBeGreaterThan(0.5);
    expect(direction.y).toBeGreaterThan(0);
    const port = worldPoint(model.ejection);
    expect(bounds.containsPoint(port)).toBe(true);
  });

  it('places the hands: trigger hand at the wrist, support hand under the fore-end', () => {
    const trigger = worldPoint(model.grips.trigger);
    const support = worldPoint(model.grips.support);
    expect(trigger.length()).toBeLessThan(0.05);
    expect(trigger.x).toBeGreaterThan(0);
    expect(support.z).toBeLessThan(-0.3);
    expect(support.z).toBeGreaterThan(-0.55);
    // Support palm faces up (+X of a left-hand grip frame is the palm normal), thumb forward along the stock.
    expect(worldAxis(model.grips.support, new THREE.Vector3(1, 0, 0)).y).toBeGreaterThan(0.5);
    expect(worldAxis(model.grips.support, new THREE.Vector3(0, 1, 0)).z).toBeLessThan(-0.5);
    // Trigger hand: fingers lead toward the muzzle, thumb up.
    expect(worldAxis(model.grips.trigger, new THREE.Vector3(0, 0, -1)).z).toBeLessThan(-0.5);
    expect(worldAxis(model.grips.trigger, new THREE.Vector3(0, 1, 0)).y).toBeGreaterThan(0.5);
  });

  it('exposes the bolt, clip and trigger, and how they move', () => {
    const { bolt, magazine, trigger } = model.parts;
    expect(bolt?.name).toBe('bolt');
    expect(magazine?.name).toBe('clip');
    expect(trigger?.name).toBe('trigger');
    expect(model.cycleTravel).toBeGreaterThan(0.06);
    expect(model.cycleTravel).toBeLessThan(0.09);
  });

  it('lifts the clip out of the top when the magazine is moved the usual way (parent -Y)', () => {
    const clip = garand.build(file.assets).parts.magazine;
    if (!clip) throw new Error('clip missing');
    const before = worldPoint(clip);
    clip.position.y -= 0.1;
    const after = worldPoint(clip);
    expect(after.y - before.y).toBeCloseTo(0.1, 3);
    expect(Math.abs(after.x - before.x)).toBeLessThan(0.001);
    // Seated, the clip is inside the receiver, under the bolt.
    expect(Math.abs(before.x)).toBeLessThan(0.002);
    expect(before.y).toBeLessThan(0.06);
    expect(before.z).toBeLessThan(-0.1);
  });

  it('builds cheap copies that share geometry and materials', () => {
    const other = garand.build(file.assets);
    expect(other.root).not.toBe(model.root);
    const meshes = (root: THREE.Object3D): THREE.Mesh[] => {
      const found: THREE.Mesh[] = [];
      root.traverse((node) => {
        if (node instanceof THREE.Mesh) found.push(node);
      });
      return found;
    };
    const first = meshes(model.root);
    const second = meshes(other.root);
    expect(second.length).toBe(first.length);
    second.forEach((mesh, index) => {
      expect(mesh.geometry).toBe(first[index].geometry);
      expect(mesh.material).toBe(first[index].material);
      expect(mesh.castShadow).toBe(true);
    });
  });
});

describe('m1garand anchors against the mesh', () => {
  const MM = 0.001;
  let model: GunModel;
  let bounds: THREE.Box3;
  let body: THREE.Vector3[];
  let eye: THREE.Vector3;
  let rear: THREE.Vector3;
  let front: THREE.Vector3;
  /** Distance from the line of sight (through the eye, along -Z). */
  const offAxis = (point: THREE.Vector3): number => Math.hypot(point.x - eye.x, point.y - eye.y);
  beforeAll(async () => {
    const file = await loadGunFile('m1garand.glb', 'mdl-gun-m1garand');
    model = garand.build(file.assets);
    model.root.updateMatrixWorld(true);
    bounds = new THREE.Box3().setFromObject(model.root, true);
    const mesh = model.root.getObjectByName('m1garand-mesh');
    const bodyNode = model.root.getObjectByName('body');
    if (!mesh || !bodyNode) throw new Error('mesh missing');
    body = surfacePoints(bodyNode, undefined, 4);
    eye = worldPoint(model.sight);
    rear = worldPoint(mesh, new THREE.Vector3(...GARAND_SIGHTS.rear));
    front = worldPoint(mesh, new THREE.Vector3(...GARAND_SIGHTS.front));
  });

  it('has the muzzle anchor at the furthest point forward, on the bore axis', () => {
    const muzzle = worldPoint(model.muzzle);
    expect(Math.abs(muzzle.z - bounds.min.z)).toBeLessThan(1.5 * MM);
    const crown = body.filter((point) => point.z < bounds.min.z + 1 * MM);
    expect(crown.length).toBeGreaterThan(12);
    const centre = new THREE.Box3().setFromPoints(crown).getCenter(new THREE.Vector3());
    expect(Math.hypot(centre.x - muzzle.x, centre.y - muzzle.y)).toBeLessThan(2 * MM);
    // The barrel behind the crown is a tube around the same axis.
    const barrel = body.filter((point) => point.z < muzzle.z + 0.02 && point.z > muzzle.z + 0.005 && Math.hypot(point.x - muzzle.x, point.y - muzzle.y) < 0.012);
    expect(barrel.length).toBeGreaterThan(20);
    const tube = new THREE.Box3().setFromPoints(barrel).getCenter(new THREE.Vector3());
    expect(Math.hypot(tube.x - muzzle.x, tube.y - muzzle.y)).toBeLessThan(2 * MM);
  });

  it('runs the line of sight through the open rear aperture', () => {
    const disc = body.filter((point) => Math.abs(point.z - rear.z) < 2.5 * MM && offAxis(point) < 5 * MM);
    expect(disc.length).toBeGreaterThan(100);
    const radii = disc.map(offAxis);
    // A clear hole about 6.5 mm across, centred on the line, inside a ring about 8.5 mm across.
    expect(Math.min(...radii)).toBeGreaterThan(2.9 * MM);
    expect(Math.min(...radii)).toBeLessThan(3.5 * MM);
    const rim = disc.filter((point) => offAxis(point) < 3.5 * MM);
    const quadrants = new Set(rim.map((point) => `${Math.sign(point.x - eye.x)}${Math.sign(point.y - eye.y)}`));
    expect(quadrants.size).toBe(4);
    for (const point of rim) expect(offAxis(point)).toBeGreaterThan(2.9 * MM);
  });

  it('touches the top of the front blade, between its ears', () => {
    const post = body.filter((point) => Math.abs(point.z - front.z) < 4 * MM && Math.abs(point.x - eye.x) < 1 * MM && point.y > eye.y - 0.01);
    expect(post.length).toBeGreaterThan(5);
    const top = Math.max(...post.map((point) => point.y));
    expect(Math.abs(top - eye.y)).toBeLessThan(0.3 * MM);
    // The protective ears stand taller than the blade on both sides.
    const ears = body.filter((point) => Math.abs(point.z - front.z) < 8 * MM && Math.abs(point.x - eye.x) > 4 * MM && point.y > eye.y + 1 * MM);
    expect(ears.some((point) => point.x < eye.x)).toBe(true);
    expect(ears.some((point) => point.x > eye.x)).toBe(true);
  });

  it('keeps the rest of the rifle out of the line of sight', () => {
    const blocking = worldVertices(model.root).filter(
      (point) => point.z < eye.z && point.z > front.z + 6 * MM && offAxis(point) < 2 * MM && point.y > eye.y - 0.5 * MM,
    );
    expect(blocking.length).toBe(0);
  });

  it('seats the eye a quarter of a metre or more behind the aperture, ahead of the butt', () => {
    const discBack = Math.max(...body.filter((point) => Math.abs(point.z - rear.z) < 2.5 * MM && offAxis(point) < 5 * MM).map((point) => point.z));
    expect(eye.z - discBack).toBeGreaterThanOrEqual(0.25);
    expect(eye.z - discBack).toBeLessThanOrEqual(0.4);
    expect(eye.z).toBeLessThan(bounds.max.z);
  });

  it('puts the trigger palm on the right of the wrist and the support palm under the fore-end', () => {
    const palm = worldPoint(model.grips.trigger);
    const wrist = body.filter((point) => Math.abs(point.z - palm.z) < 0.015 && Math.abs(point.y - palm.y) < 0.015);
    expect(Math.abs(palm.x - Math.max(...wrist.map((point) => point.x)))).toBeLessThan(6 * MM);
    const trigger = model.parts.trigger;
    if (!trigger) throw new Error('trigger missing');
    expect(palm.z).toBeGreaterThan(new THREE.Box3().setFromObject(trigger, true).max.z + 0.03);

    const support = worldPoint(model.grips.support);
    const under = body.filter((point) => Math.abs(point.z - support.z) < 0.02 && Math.abs(point.x) < 0.01);
    const bottom = Math.min(...under.map((point) => point.y));
    expect(support.y).toBeLessThan(bottom + 2 * MM);
    expect(bottom - support.y).toBeLessThan(0.02);
    expect(Math.abs(support.x)).toBeLessThan(0.02);
    expect(worldAxis(model.grips.support, new THREE.Vector3(0, 0, -1)).x).toBeGreaterThan(0.9);
  });

  it('puts the ejection anchor over the action, beside the bolt', () => {
    const port = worldPoint(model.ejection);
    const bolt = model.parts.bolt;
    if (!bolt) throw new Error('bolt missing');
    const action = new THREE.Box3().setFromObject(bolt, true);
    expect(port.x).toBeGreaterThan(0);
    expect(port.x).toBeLessThan(0.025);
    expect(port.z).toBeGreaterThan(action.min.z);
    expect(port.z).toBeLessThan(action.max.z);
    expect(port.y).toBeGreaterThan(action.min.y);
    expect(port.y).toBeLessThan(action.max.y + 5 * MM);
  });

  it('hides the liner of the magazine well inside the stock, under the bolt', () => {
    const liner = model.root.getObjectByName('well-liner');
    const bolt = model.parts.bolt;
    if (!liner || !bolt) throw new Error('liner or bolt missing');
    const box = new THREE.Box3().setFromObject(liner, true);
    const shell = body.filter((point) => point.z > box.min.z && point.z < box.max.z && point.y > box.min.y && point.y < box.max.y - 3 * MM);
    expect(box.max.x).toBeLessThan(Math.max(...shell.map((point) => point.x)));
    expect(box.min.x).toBeGreaterThan(Math.min(...shell.map((point) => point.x)));
    expect(box.max.y).toBeLessThan(new THREE.Box3().setFromObject(bolt, true).min.y);
    expect((liner as THREE.Mesh).castShadow).toBe(true);
  });
});
