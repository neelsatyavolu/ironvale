/**
 * Shared assembly for the guns-b rifles (M1 Garand, M24 slot). Each gun file
 * supplies measurements taken from its processed glTF; this turns them into a
 * `GunModel` with anchors as direct children of the root.
 */
import * as THREE from 'three/webgpu';
import type { Assets } from '../../../core/assets';
import type { GunModel } from '../../../game/contracts';
import type { WeaponId } from '../api';

export type Vec3 = readonly [number, number, number];

export interface GripSpec {
  /** Palm centre in mesh space. */
  readonly at: Vec3;
  /** Direction the straightened fingers point, in mesh space. */
  readonly fingers: Vec3;
  /** Direction of the thumb side of the hand; made perpendicular to `fingers`. */
  readonly thumb: Vec3;
}

export interface RifleSpec {
  readonly weaponId: WeaponId;
  readonly assetId: string;
  /** Two points in mesh space the line of sight passes through, rear first. */
  sightLine(mesh: THREE.Object3D): { readonly rear: THREE.Vector3; readonly front: THREE.Vector3 };
  /** Metres from the rear sight or eyepiece back to the eye. */
  readonly eyeRelief: number;
  /** Centre of the muzzle crown in mesh space. */
  readonly muzzle: Vec3;
  /** Ejection port centre and the direction cases leave in, in mesh space. */
  readonly ejection: { readonly at: Vec3; readonly toward: Vec3 };
  readonly triggerGrip: GripSpec;
  readonly supportGrip: GripSpec;
  /**
   * glTF node names of the moving parts. The view model slides `bolt` back along
   * +Z, rolls a turn bolt about its own +Z (positive lifts a right-hand handle),
   * and removes `magazine` along its parent's -Y.
   */
  readonly parts: { readonly bolt: string; readonly magazine: string; readonly trigger: string };
  /** Metres the bolt travels back along +Z. */
  readonly cycleTravel: number;
  /** Per-build changes to the cloned mesh tree (swap in code-built materials, hide nodes). */
  dress?(mesh: THREE.Object3D): void;
}

export interface SightSolution {
  /** Rotation about the gun's origin that lays the line of sight along -Z. */
  readonly tilt: THREE.Quaternion;
  /** Eye position in the tilted frame: on the line of sight, `relief` behind the rear point. */
  readonly eye: THREE.Vector3;
}

const FORWARD = new THREE.Vector3(0, 0, -1);
const RIGHT = new THREE.Vector3(1, 0, 0);

/**
 * Sights on a real rifle are rarely exactly parallel to the bore. Rather than
 * angle the sight anchor, tilt the whole gun by the fraction of a degree it
 * takes to put both sight points on one line parallel to -Z, so the anchor can
 * keep an identity rotation.
 */
export function alignSights(rear: THREE.Vector3, front: THREE.Vector3, relief: number): SightSolution {
  const line = front.clone().sub(rear);
  if (line.lengthSq() < 1e-12 || line.z >= 0) {
    throw new Error('Sight line needs a front point further down -Z than the rear point');
  }
  const tilt = new THREE.Quaternion().setFromUnitVectors(line.normalize(), FORWARD);
  const eye = rear.clone().applyQuaternion(tilt);
  eye.z += relief;
  return { tilt, eye };
}

/** Hand frame for a grip anchor: -Z along the fingers, +Y toward the thumb side. */
export function gripFrame(fingers: Vec3, thumb: Vec3): THREE.Quaternion {
  const z = new THREE.Vector3(...fingers).normalize().negate();
  const y = new THREE.Vector3(...thumb);
  y.addScaledVector(z, -y.dot(z));
  if (y.lengthSq() < 1e-10) throw new Error('Grip thumb direction is parallel to the fingers');
  y.normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

/** Rotation whose +X axis is `direction`. */
export function directionFrame(direction: THREE.Vector3): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(RIGHT, direction.clone().normalize());
}

function requireNode(mesh: THREE.Object3D, name: string, weaponId: string): THREE.Object3D {
  const node = mesh.getObjectByName(name);
  if (!node) throw new Error(`${weaponId} model has no "${name}" node; rerun scripts/process-gun-${weaponId}.mjs`);
  return node;
}

/** Position of `node`'s origin in the space of `mesh`, an ancestor that has not been transformed yet. */
export function originIn(mesh: THREE.Object3D, name: string): THREE.Vector3 {
  const node = mesh.getObjectByName(name);
  if (!node) throw new Error(`Model has no "${name}" node`);
  mesh.updateWorldMatrix(true, true);
  return mesh.worldToLocal(node.getWorldPosition(new THREE.Vector3()));
}

function enableShadows(mesh: THREE.Object3D): void {
  mesh.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.castShadow = true;
    node.receiveShadow = true;
  });
}

function anchor(root: THREE.Object3D, name: string, position: THREE.Vector3, rotation?: THREE.Quaternion): THREE.Object3D {
  const empty = new THREE.Object3D();
  empty.name = name;
  empty.position.copy(position);
  if (rotation) empty.quaternion.copy(rotation);
  root.add(empty);
  return empty;
}

/** Clone the cached glTF and wrap it as a `GunModel`. Geometry and materials are shared between builds. */
export function buildRifle(assets: Assets, spec: RifleSpec): GunModel {
  const mesh = assets.model(spec.assetId);
  mesh.name = `${spec.weaponId}-mesh`;
  spec.dress?.(mesh);
  enableShadows(mesh);

  const sights = spec.sightLine(mesh);
  const { tilt, eye } = alignSights(sights.rear, sights.front, spec.eyeRelief);
  mesh.quaternion.copy(tilt);

  const root = new THREE.Group();
  root.name = spec.weaponId;
  root.add(mesh);

  const place = (point: Vec3): THREE.Vector3 => new THREE.Vector3(...point).applyQuaternion(tilt);
  const grip = (name: string, grip: GripSpec): THREE.Object3D =>
    anchor(root, name, place(grip.at), tilt.clone().multiply(gripFrame(grip.fingers, grip.thumb)));

  return {
    root,
    muzzle: anchor(root, 'muzzle', place(spec.muzzle)),
    ejection: anchor(
      root,
      'ejection',
      place(spec.ejection.at),
      tilt.clone().multiply(directionFrame(new THREE.Vector3(...spec.ejection.toward))),
    ),
    sight: anchor(root, 'sight', eye),
    parts: {
      bolt: requireNode(mesh, spec.parts.bolt, spec.weaponId),
      magazine: requireNode(mesh, spec.parts.magazine, spec.weaponId),
      trigger: requireNode(mesh, spec.parts.trigger, spec.weaponId),
    },
    cycleTravel: spec.cycleTravel,
    grips: { trigger: grip('grip-trigger', spec.triggerGrip), support: grip('grip-support', spec.supportGrip) },
  };
}
