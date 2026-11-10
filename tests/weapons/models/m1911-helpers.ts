/**
 * Shared checks for the processed gun files of the m1911, mp5 and r870
 * (public/assets/local/guns/<id>.glb) and the layouts that turn them into a
 * `GunModel`. The file is read with gltf-transform, so no GPU or DOM is needed.
 */
import { getBounds, NodeIO, type Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { Group, Object3D, Quaternion, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { GunModel } from '../../../src/game/contracts';
import type { GunModule, WeaponId } from '../../../src/weapons/models/api';
import { assembleGun, type GunLayout } from '../../../src/weapons/models/lib/guns-a-assemble';
import { castRay, distanceToSurface, readParts, verticesOf } from './m1911-mesh';

export interface GunExpectations {
  /** Overall length in metres, tolerance 5%. */
  readonly length: number;
  /** Rear-to-front sight distance in metres, tolerance 10%. */
  readonly sightRadius: number;
  readonly maxTriangles: number;
  /** Part seen through the ejection port from the right: the bolt, or the barrel hood on a pistol. */
  readonly behindPort: string;
  /** A post or blade whose top the eye line skims, or a bead it passes through. */
  readonly frontSight: 'post' | 'bead';
  /** False for a bead-only shotgun, whose eye line just clears the receiver instead. */
  readonly rearSight: boolean;
  /** Long guns: the eye must sit ahead of the butt plate, as it does with the stock in the shoulder. */
  readonly shouldered: boolean;
}

/** Vertices this close behind the frontmost point count as the muzzle's front face. */
const CROWN_DEPTH = 0.00075;
/** Furthest a palm centre may float off the surface it holds. */
const MAX_PALM_GAP = 0.03;

interface Loaded {
  readonly document: Document;
  readonly scene: Group;
  readonly min: Vector3;
  readonly max: Vector3;
  readonly bytes: number;
}

async function load(id: WeaponId): Promise<Loaded> {
  const file = decodeURIComponent(new URL(`../../../public/assets/local/guns/${id}.glb`, import.meta.url).pathname);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.read(file);
  const source = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  const scene = new Group();
  for (const node of source.listChildren()) {
    const object = new Object3D();
    object.name = node.getName();
    object.position.fromArray(node.getTranslation());
    object.quaternion.fromArray(node.getRotation());
    scene.add(object);
  }
  const bounds = getBounds(source);
  return {
    document,
    scene,
    min: new Vector3().fromArray(bounds.min),
    max: new Vector3().fromArray(bounds.max),
    // Size of the file as written back out, which matches what is on disk.
    bytes: (await io.writeBinary(document)).byteLength,
  };
}

const worldPosition = (object: Object3D) => object.getWorldPosition(new Vector3());
const worldAxis = (object: Object3D, x: number, y: number, z: number) =>
  new Vector3(x, y, z).applyQuaternion(object.getWorldQuaternion(new Quaternion()));

function distanceToLine(point: Vector3, origin: Vector3, direction: Vector3): number {
  const offset = point.clone().sub(origin);
  return offset.sub(direction.clone().multiplyScalar(offset.dot(direction))).length();
}

/** Registers the checks every processed gun must pass. */
export function describeGun(module: GunModule, layout: GunLayout, expected: GunExpectations): void {
  describe(`${module.weaponId} gun model`, () => {
    const build = async (): Promise<{ loaded: Loaded; gun: GunModel }> => {
      const loaded = await load(module.weaponId);
      const gun = assembleGun(loaded.scene, layout);
      gun.root.updateMatrixWorld(true);
      return { loaded, gun };
    };

    it('is a small file the loader can read without extra decoders', async () => {
      const { document, bytes } = await load(module.weaponId);
      const root = document.getRoot();
      expect(bytes).toBeLessThan(3 * 1024 * 1024);
      expect(root.listExtensionsUsed().map((extension) => extension.extensionName)).toEqual(['EXT_texture_webp']);
      expect(root.listSkins()).toHaveLength(0);
      for (const texture of root.listTextures()) {
        expect(texture.getMimeType()).toBe('image/webp');
        expect(Math.max(...(texture.getSize() ?? [0, 0]))).toBeLessThanOrEqual(2048);
      }
      let triangles = 0;
      for (const mesh of root.listMeshes()) {
        for (const primitive of mesh.listPrimitives()) triangles += (primitive.getIndices()?.getCount() ?? 0) / 3;
      }
      expect(triangles).toBeGreaterThan(2000);
      expect(triangles).toBeLessThanOrEqual(expected.maxTriangles);
    });

    it('is real size with the barrel along -Z and the grip at the origin', async () => {
      const { loaded } = await build();
      const length = loaded.max.z - loaded.min.z;
      expect(Math.abs(length - expected.length) / expected.length).toBeLessThan(0.05);
      // Longer than tall, taller than wide, and centred left to right.
      expect(length).toBeGreaterThan(loaded.max.y - loaded.min.y);
      expect(loaded.max.y - loaded.min.y).toBeGreaterThan(loaded.max.x - loaded.min.x);
      expect(Math.abs(loaded.max.x + loaded.min.x)).toBeLessThan(0.02);
      // The origin is inside the grip: the gun reaches forward, back, above and below it.
      expect(loaded.min.z).toBeLessThan(-0.1);
      expect(loaded.max.z).toBeGreaterThan(0.01);
      expect(loaded.min.y).toBeLessThan(-0.02);
      expect(loaded.max.y).toBeGreaterThan(0.03);
    });

    it('has the muzzle at the front of the barrel on the centre line', async () => {
      const { loaded, gun } = await build();
      const muzzle = worldPosition(gun.muzzle);
      expect(muzzle.z - loaded.min.z).toBeLessThan(0.03);
      expect(muzzle.z).toBeGreaterThanOrEqual(loaded.min.z - 1e-6);
      expect(Math.abs(muzzle.x)).toBeLessThan(0.002);
      expect(muzzle.y).toBeGreaterThan(0);
      expect(worldAxis(gun.muzzle, 0, 0, -1).z).toBeCloseTo(-1, 6);
    });

    it('ejects to the right from a port between the grip and the muzzle', async () => {
      const { gun } = await build();
      const port = worldPosition(gun.ejection);
      expect(port.x).toBeGreaterThan(0);
      expect(port.z).toBeLessThan(0.05);
      expect(port.z).toBeGreaterThan(worldPosition(gun.muzzle).z);
      const out = worldAxis(gun.ejection, 1, 0, 0);
      expect(out.x).toBeGreaterThan(0.7);
      expect(out.y).toBeGreaterThanOrEqual(0);
    });

    it('lines the eye up with both sights, 0.25 to 0.4 m behind the rear one', async () => {
      const { loaded, gun } = await build();
      const rear = loaded.scene.getObjectByName('anchor_sight_rear')!.position;
      const front = loaded.scene.getObjectByName('anchor_sight_front')!.position;
      const eye = worldPosition(gun.sight);
      const forward = worldAxis(gun.sight, 0, 0, -1);
      expect(distanceToLine(rear, eye, forward)).toBeLessThan(1e-5);
      expect(distanceToLine(front, eye, forward)).toBeLessThan(1e-5);
      const relief = eye.distanceTo(rear);
      expect(relief).toBeGreaterThanOrEqual(0.25 - 1e-9);
      expect(relief).toBeLessThanOrEqual(0.4 + 1e-9);
      // No roll, nearly parallel to the bore, above it, on the centre line.
      expect(worldAxis(gun.sight, 1, 0, 0).y).toBeCloseTo(0, 6);
      expect(forward.z).toBeLessThan(-0.999);
      expect(Math.abs(rear.x)).toBeLessThan(0.001);
      expect(Math.abs(front.x)).toBeLessThan(0.001);
      expect(rear.y).toBeGreaterThan(worldPosition(gun.muzzle).y);
      const radius = rear.distanceTo(front);
      expect(Math.abs(radius - expected.sightRadius) / expected.sightRadius).toBeLessThan(0.1);
    });

    it('exposes its moving parts at rest and a sensible cycle travel', async () => {
      const { gun } = await build();
      const names = Object.keys(layout.parts);
      expect(names.length).toBeGreaterThan(0);
      expect(Object.keys(gun.parts).sort()).toEqual([...names].sort());
      for (const part of Object.values(gun.parts)) {
        expect(part.position.length()).toBe(0);
        expect(part.quaternion.equals(new Quaternion())).toBe(true);
      }
      expect(gun.parts.bolt ?? gun.parts.slide ?? gun.parts.pump).toBeDefined();
      expect(gun.cycleTravel).toBeGreaterThan(0.02);
      expect(gun.cycleTravel).toBeLessThan(0.12);
    });

    it('puts the hands on the gun: trigger hand at the grip, support hand left of or below the bore', async () => {
      const { loaded, gun } = await build();
      const trigger = worldPosition(gun.grips.trigger);
      const support = worldPosition(gun.grips.support);
      const margin = 0.03;
      for (const hand of [trigger, support]) {
        expect(hand.z).toBeGreaterThan(loaded.min.z);
        expect(hand.z).toBeLessThan(loaded.max.z);
        expect(hand.y).toBeGreaterThan(loaded.min.y - margin);
        expect(hand.y).toBeLessThan(loaded.max.y);
        expect(Math.abs(hand.x)).toBeLessThan(loaded.max.x + margin);
      }
      expect(trigger.length()).toBeLessThan(0.06);
      expect(trigger.x).toBeGreaterThan(0);
      expect(support.z).toBeLessThanOrEqual(trigger.z);
      expect(support.x <= 0 || support.y < worldPosition(gun.muzzle).y).toBe(true);
      // The trigger hand points forward with the thumb up.
      expect(worldAxis(gun.grips.trigger, 0, 0, -1).z).toBeLessThan(-0.8);
      expect(worldAxis(gun.grips.trigger, 0, 1, 0).y).toBeGreaterThan(0.8);
    });

    it('puts the muzzle on the crown: the centre of the frontmost face of the barrel', async () => {
      const { loaded, gun } = await build();
      const muzzle = worldPosition(gun.muzzle);
      const points = verticesOf(readParts(loaded.document));
      const front = Math.min(...points.map((point) => point.z));
      expect(Math.abs(muzzle.z - front)).toBeLessThan(1e-4);
      const face = points.filter((point) => point.z <= front + CROWN_DEPTH);
      const xs = face.map((point) => point.x);
      const ys = face.map((point) => point.y);
      const width = Math.max(...xs) - Math.min(...xs);
      const height = Math.max(...ys) - Math.min(...ys);
      // A round face 10 to 30 mm across, with the anchor within half a millimetre of its centre.
      expect(width).toBeGreaterThan(0.01);
      expect(width).toBeLessThan(0.03);
      expect(Math.abs(width - height) / width).toBeLessThan(0.1);
      expect(Math.abs(muzzle.x - (Math.max(...xs) + Math.min(...xs)) / 2)).toBeLessThan(0.0005);
      expect(Math.abs(muzzle.y - (Math.max(...ys) + Math.min(...ys)) / 2)).toBeLessThan(0.0005);
    });

    it('has a clear line of sight that meets the front sight', async () => {
      const { loaded, gun } = await build();
      const parts = readParts(loaded.document);
      const front = loaded.scene.getObjectByName('anchor_sight_front')!.position;
      const eye = worldPosition(gun.sight);
      const forward = worldAxis(gun.sight, 0, 0, -1);
      const up = worldAxis(gun.sight, 0, 1, 0);
      const reach = eye.distanceTo(front) + 0.05;
      const cast = (lift: number) => castRay(parts, eye.clone().addScaledVector(up, lift), forward, reach);
      if (expected.frontSight === 'post') {
        // Nothing blocks the line itself; just under it the first thing in the way is the tip of the front sight.
        expect(cast(0.0003)).toBeNull();
        const tip = cast(-0.0006);
        expect(tip).not.toBeNull();
        expect(Math.abs(tip!.point.z - front.z)).toBeLessThan(0.012);
      } else {
        // The line runs into the bead before anything else, and clears it a few millimetres higher.
        const bead = cast(0);
        expect(bead).not.toBeNull();
        expect(Math.abs(bead!.point.z - front.z)).toBeLessThan(0.006);
        expect(cast(0.004)).toBeNull();
      }
    });

    it('frames the line of sight with the rear sight, and keeps the eye clear of the gun', async () => {
      const { loaded, gun } = await build();
      const points = verticesOf(readParts(loaded.document));
      const rear = loaded.scene.getObjectByName('anchor_sight_rear')!.position;
      const eye = worldPosition(gun.sight);
      if (expected.rearSight) {
        // Metal reaches the height of the line on both sides of it, within a centimetre of the anchor.
        const ears = points.filter((point) => Math.abs(point.z - rear.z) < 0.012 && point.y >= rear.y - 0.0002);
        expect(ears.some((point) => point.x < -0.0005)).toBe(true);
        expect(ears.some((point) => point.x > 0.0005)).toBe(true);
      }
      if (expected.shouldered) expect(eye.z).toBeLessThan(loaded.max.z - 0.01);
      const nearest = Math.min(...points.map((point) => point.distanceTo(eye)));
      expect(nearest).toBeGreaterThan(0.025);
    });

    it('has the ejection anchor at the mouth of the port, with the action visible through it', async () => {
      const { loaded, gun } = await build();
      const port = worldPosition(gun.ejection);
      const outside = port.clone().add(new Vector3(0.05, 0, 0));
      const hit = castRay(readParts(loaded.document), outside, new Vector3(-1, 0, 0), 0.1);
      expect(hit).not.toBeNull();
      expect(hit!.part).toBe(expected.behindPort);
      expect(port.x - hit!.point.x).toBeGreaterThanOrEqual(0);
      expect(port.x - hit!.point.x).toBeLessThan(0.012);
    });

    it('keeps both palms within reach of the surface of the gun', async () => {
      const { loaded, gun } = await build();
      const parts = readParts(loaded.document);
      for (const grip of [gun.grips.trigger, gun.grips.support]) {
        const distance = distanceToSurface(parts, worldPosition(grip));
        expect(distance).toBeLessThan(MAX_PALM_GAP);
      }
    });

    it('names its weapon and the asset it needs', () => {
      expect(module.assets).toHaveLength(1);
      expect(module.assets![0]).toBe(`mdl-gun-${module.weaponId}`);
    });
  });
}
