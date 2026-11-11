/**
 * Turns a processed gun glTF (see scripts/process-gun-a-common.mjs) into a
 * `GunModel`. The file holds one node per moving part (`part_*`) and empties
 * for the points measured from the mesh (`anchor_muzzle`, `anchor_ejection`,
 * `anchor_sight_front`, `anchor_sight_rear`). Hand positions and travel are
 * tuned by eye and live in each gun's layout.
 */
import * as THREE from 'three/webgpu';
import type { GunModel } from '../../../game/contracts';

export type PartName = keyof GunModel['parts'];
export type Triple = readonly [number, number, number];

export interface GripSpec {
  /** Palm centre in gun space, with every part at rest. */
  readonly position: Triple;
  /** Direction the fingers point. */
  readonly fingers: Triple;
  /** Direction of the thumb side of the hand; squared up against `fingers`. */
  readonly thumb: Triple;
  /** Part the hand rides on (a slide, a moving fore-end). Fixed to the gun when omitted. */
  readonly on?: PartName;
}

export interface GunLayout {
  /** glTF node name of each moving part the model has. */
  readonly parts: Readonly<Partial<Record<PartName, string>>>;
  /** Travel in metres along +Z of the bolt or slide. */
  readonly cycleTravel: number;
  /** Distance from the rear sight back to the eye, in metres. */
  readonly eyeRelief: number;
  /** Degrees the ejection direction is tilted up from straight out to the right. */
  readonly ejectionTiltDeg?: number;
  readonly grips: { readonly trigger: GripSpec; readonly support: GripSpec };
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Where the eye sits to see the front sight through the rear sight: on the
 * line through both, `eyeRelief` behind the rear one, looking along it.
 */
export function sightPose(
  rear: THREE.Vector3,
  front: THREE.Vector3,
  eyeRelief: number,
): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  const direction = front.clone().sub(rear);
  if (direction.z >= 0) throw new Error('The front sight must be ahead of the rear sight (further down -Z)');
  direction.normalize();
  const position = rear.clone().addScaledVector(direction, -eyeRelief);
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(position, front, UP));
  return { position, quaternion };
}

/** Rotation whose -Z is the finger direction and whose +Y leans toward the thumb. */
export function gripBasis(fingers: Triple, thumb: Triple): THREE.Quaternion {
  const z = new THREE.Vector3(...fingers).normalize().negate();
  const y = new THREE.Vector3(...thumb);
  y.addScaledVector(z, -y.dot(z));
  if (y.lengthSq() < 1e-10) throw new Error('Grip thumb direction is parallel to the fingers');
  y.normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

function find(scene: THREE.Object3D, name: string): THREE.Object3D {
  const node = scene.getObjectByName(name);
  if (!node) throw new Error(`Gun model has no node named "${name}"`);
  return node;
}

/**
 * Re-parent a part under a holder at its pivot so the part itself rests at the
 * identity: animating code can then write `part.position.z = travel` or rotate
 * it about its pivot without knowing where it sits on the gun.
 */
function restAtIdentity(part: THREE.Object3D): void {
  const holder = new THREE.Group();
  holder.name = `${part.name}_rest`;
  holder.position.copy(part.position);
  holder.quaternion.copy(part.quaternion);
  part.parent?.add(holder);
  holder.add(part);
  part.position.set(0, 0, 0);
  part.quaternion.identity();
}

function empty(name: string): THREE.Object3D {
  const object = new THREE.Object3D();
  object.name = name;
  return object;
}

/**
 * Build the `GunModel` around `scene`, a fresh clone of the gun's glTF scene.
 * The scene becomes the model's root.
 */
export function assembleGun(scene: THREE.Object3D, layout: GunLayout): GunModel {
  const muzzle = find(scene, 'anchor_muzzle');
  const ejection = find(scene, 'anchor_ejection');
  const front = find(scene, 'anchor_sight_front');
  const rear = find(scene, 'anchor_sight_rear');
  ejection.rotation.z = THREE.MathUtils.degToRad(layout.ejectionTiltDeg ?? 0);

  const sight = empty('anchor_sight');
  const pose = sightPose(rear.position, front.position, layout.eyeRelief);
  sight.position.copy(pose.position);
  sight.quaternion.copy(pose.quaternion);
  scene.add(sight);

  const parts: { -readonly [K in PartName]?: THREE.Object3D } = {};
  for (const [part, nodeName] of Object.entries(layout.parts) as [PartName, string][]) {
    const node = find(scene, nodeName);
    restAtIdentity(node);
    parts[part] = node;
  }

  const grip = (name: string, spec: GripSpec): THREE.Object3D => {
    const object = empty(name);
    object.position.set(...spec.position);
    object.quaternion.copy(gripBasis(spec.fingers, spec.thumb));
    const parent = spec.on ? parts[spec.on] : scene;
    if (!parent) throw new Error(`Grip "${name}" rides on part "${spec.on}", which this gun does not have`);
    if (spec.on && parent.parent) {
      // Layout positions are in gun space; keep them there when riding on a part.
      object.position.sub(parent.parent.position);
    }
    parent.add(object);
    return object;
  };

  scene.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  return {
    root: scene,
    muzzle,
    ejection,
    sight,
    parts,
    cycleTravel: layout.cycleTravel,
    grips: { trigger: grip('grip_trigger', layout.grips.trigger), support: grip('grip_support', layout.grips.support) },
  };
}
