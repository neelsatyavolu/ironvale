/**
 * Turns a processed gun glTF (scripts/process-gun-m4a1.mjs, -m249.mjs) and its
 * layout into a `GunModel`. Geometry and materials stay shared between builds.
 */
import * as THREE from 'three/webgpu';
import type { GunModel } from '../../../game/contracts';
import { gripPose, sightPose, type GunLayout, type PartName, type Pose } from './guns-c-layout';

function anchor(parent: THREE.Object3D, name: string, pose: Pose): THREE.Object3D {
  const object = new THREE.Object3D();
  object.name = name;
  object.position.copy(pose.position);
  object.quaternion.copy(pose.quaternion);
  parent.add(object);
  return object;
}

/**
 * Re-parent a part under a holder at its pivot so the part itself rests at the
 * identity: the view model can write `part.position.z = travel` or rotate the
 * part about its pivot without knowing where it sits on the gun.
 */
function restAtIdentity(part: THREE.Object3D): void {
  const parent = part.parent;
  if (!parent) throw new Error(`Gun part "${part.name}" has no parent`);
  const holder = new THREE.Group();
  holder.name = `${part.name}_rest`;
  holder.position.copy(part.position);
  parent.add(holder);
  holder.add(part);
  part.position.set(0, 0, 0);
}

/**
 * Build the model around `scene`, a fresh clone of the gun's glTF scene, which
 * becomes the root. `material` maps each source material to the tuned one.
 */
export function assembleGun(
  scene: THREE.Object3D,
  layout: GunLayout,
  material: (source: THREE.Material) => THREE.Material,
): GunModel {
  scene.name = layout.asset;
  scene.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.castShadow = true;
    child.receiveShadow = true;
    child.material = material(child.material as THREE.Material);
  });

  const parts: { -readonly [K in PartName]?: THREE.Object3D } = {};
  for (const [part, nodeName] of Object.entries(layout.parts) as [PartName, string][]) {
    const node = scene.getObjectByName(nodeName);
    if (!node) throw new Error(`Gun model "${layout.asset}" has no node named "${nodeName}"`);
    restAtIdentity(node);
    parts[part] = node;
  }

  const level = new THREE.Quaternion();
  const ejectionTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(layout.ejectionTiltDeg));
  return {
    root: scene,
    muzzle: anchor(scene, 'anchor_muzzle', { position: new THREE.Vector3(...layout.muzzle), quaternion: level }),
    ejection: anchor(scene, 'anchor_ejection', { position: new THREE.Vector3(...layout.ejection), quaternion: ejectionTilt }),
    sight: anchor(scene, 'anchor_sight', sightPose(layout)),
    parts,
    cycleTravel: layout.cycleTravel,
    grips: {
      trigger: anchor(scene, 'grip_trigger', gripPose(layout.grips.trigger)),
      support: anchor(scene, 'grip_support', gripPose(layout.grips.support)),
    },
  };
}
