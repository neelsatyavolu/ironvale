/**
 * Everything soldiers share: the loaded model, clip data, rest-pose
 * measurements, arm calibration and the two team materials. Built once per
 * loaded glTF and cached.
 */
import * as THREE from 'three/webgpu';
import { color, dot, float, materialColor, mix, texture, vec3 } from 'three/tsl';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { Assets } from '../core/assets';
import type { Team } from '../game/contracts';
import { CLIP_BONES, CLIP_FPS, CLIP_META, type ClipName } from './clip-meta';
import { calibrateArm, type ArmSetup, type JointRest } from './ik';
import { buildClipData, type ClipData } from './pose';

export const SOLDIER_ASSET = 'mdl-char-soldier';
export const CARBINE_ASSET = 'mdl-char-carbine';

export type BoneName = (typeof CLIP_BONES)[number];
export const BONE_INDEX = Object.fromEntries(CLIP_BONES.map((name, index) => [name, index])) as Record<BoneName, number>;

export interface ArmRig {
  readonly setup: ArmSetup;
  readonly shoulder: number;
  readonly upper: number;
  readonly lower: number;
  readonly hand: number;
}

export interface FingerRig {
  readonly name: string;
  /** Local rotation with the fingers wrapped around a grip. */
  readonly grip: THREE.Quaternion;
}

export interface SoldierRig {
  readonly template: THREE.Object3D;
  readonly clips: Readonly<Record<ClipName, ClipData>>;
  /** Parent of each clip bone as an index into `CLIP_BONES`, -1 for the hips. */
  readonly parents: readonly number[];
  /** Rest offset of each clip bone from its parent, in the parent's space. */
  readonly offsets: readonly THREE.Vector3[];
  /** Local rotation of each clip bone in the rest pose. */
  readonly restLocal: readonly THREE.Quaternion[];
  /** Model-space rotation of each clip bone in the rest pose. */
  readonly restModel: readonly THREE.Quaternion[];
  readonly arms: { readonly left: ArmRig; readonly right: ArmRig };
  readonly fingers: readonly FingerRig[];
  readonly material: (team: Team) => THREE.Material;
  readonly carbine: { readonly geometry: THREE.BufferGeometry; readonly material: THREE.Material };
}

/**
 * Team colours for the uniform cloth. The camouflage pattern keeps its
 * contrast; only its hue and overall value move, so the two sides read apart
 * at a glance without either looking painted.
 */
const TEAM_TINT: Readonly<Record<Team, { color: number; gain: number; amount: number }>> = {
  alpha: { color: 0x8f7d5e, gain: 1.75, amount: 0.7 },
  bravo: { color: 0x4f5a34, gain: 2.0, amount: 0.92 },
};

/**
 * Curl in radians for the three joints of the finger chain (the mesh has one
 * chain for all four fingers), and how far the thumb folds in. The right hand
 * makes a fist on the pistol grip; the left cups the handguard from below.
 */
const FINGER_CURL = { Right: [0.95, 1.2, 0.8], Left: [1.25, 0.9, 0.5] } as const;
const THUMB_FOLD = { Right: [0.5, 0.35, 0.3], Left: [0.25, 0.2, 0.2] } as const;

const rigs = new WeakMap<GLTF, SoldierRig>();

export function soldierRig(assets: Assets): SoldierRig {
  const gltf = assets.gltf(SOLDIER_ASSET);
  let rig = rigs.get(gltf);
  if (!rig) {
    rig = buildRig(gltf, assets.gltf(CARBINE_ASSET));
    rigs.set(gltf, rig);
  }
  return rig;
}

function findMesh<T extends THREE.Mesh>(root: THREE.Object3D, label: string): T {
  let found: T | null = null;
  root.traverse((child) => {
    if (!found && (child as THREE.Mesh).isMesh) found = child as T;
  });
  if (!found) throw new Error(`${label} has no mesh`);
  return found;
}

function buildRig(gltf: GLTF, carbineGltf: GLTF): SoldierRig {
  const template = gltf.scene;
  template.updateMatrixWorld(true);
  const rest = (name: string): JointRest => {
    const node = template.getObjectByName(name);
    if (!node) throw new Error(`Soldier model has no bone "${name}"`);
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    node.matrixWorld.decompose(p, q, new THREE.Vector3());
    return { q, p };
  };

  const clips = {} as Record<ClipName, ClipData>;
  for (const name of Object.keys(CLIP_META) as ClipName[]) {
    const clip = gltf.animations.find((item) => item.name === name);
    if (!clip) throw new Error(`Soldier model has no clip "${name}"`);
    clips[name] = buildClipData({ bones: CLIP_BONES, fps: CLIP_FPS, loop: CLIP_META[name].loop, tracks: clip.tracks });
  }

  const parents = CLIP_BONES.map((name) => {
    const parent = template.getObjectByName(name)?.parent?.name as BoneName | undefined;
    return parent !== undefined && parent in BONE_INDEX ? BONE_INDEX[parent] : -1;
  });
  const offsets = CLIP_BONES.map((name) => template.getObjectByName(name)!.position.clone());

  const arm = (side: 'left' | 'right'): ArmRig => {
    const Side = side === 'left' ? 'Left' : 'Right';
    const setup = calibrateArm({
      side,
      upper: rest(`${Side}Arm`),
      lower: rest(`${Side}ForeArm`),
      hand: rest(`${Side}Hand`),
      fingers: rest(`${Side}HandIndex1`).p,
      thumb: rest(`${Side}HandThumb1`).p,
    });
    return {
      setup,
      shoulder: BONE_INDEX[`${Side}Shoulder`],
      upper: BONE_INDEX[`${Side}Arm`],
      lower: BONE_INDEX[`${Side}ForeArm`],
      hand: BONE_INDEX[`${Side}Hand`],
    };
  };

  // Fingers: in the T-pose they curl downwards, about the model's Z axis.
  const fingers: FingerRig[] = [];
  for (const Side of ['Left', 'Right'] as const) {
    const sign = Side === 'Right' ? -1 : 1;
    const curl = (name: string, axis: THREE.Vector3, angle: number): void => {
      const node = template.getObjectByName(name);
      if (!node) return;
      const local = axis.clone().applyQuaternion(rest(name).q.invert());
      fingers.push({ name, grip: node.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(local, angle)) });
    };
    FINGER_CURL[Side].forEach((angle, joint) => curl(`${Side}HandIndex${joint + 1}`, new THREE.Vector3(0, 0, 1), sign * angle));
    THUMB_FOLD[Side].forEach((angle, joint) => curl(`${Side}HandThumb${joint + 1}`, new THREE.Vector3(sign * 0.5, -0.6, -0.6).normalize(), -sign * angle));
  }

  const source = findMesh<THREE.SkinnedMesh>(template, 'Soldier model').material as THREE.MeshStandardMaterial;
  const materials = new Map<Team, THREE.Material>();
  const material = (team: Team): THREE.Material => {
    let made = materials.get(team);
    if (!made) {
      made = teamMaterial(source, team);
      materials.set(team, made);
    }
    return made;
  };

  const carbine = findMesh<THREE.Mesh>(carbineGltf.scene, 'Carbine model');
  return {
    template,
    clips,
    parents,
    offsets,
    restLocal: CLIP_BONES.map((name) => template.getObjectByName(name)!.quaternion.clone()),
    restModel: CLIP_BONES.map((name) => rest(name).q),
    arms: { left: arm('left'), right: arm('right') },
    fingers,
    material,
    carbine: { geometry: carbine.geometry, material: carbine.material as THREE.Material },
  };
}

function teamMaterial(source: THREE.MeshStandardMaterial, team: Team): THREE.Material {
  const material = new THREE.MeshStandardNodeMaterial({
    map: source.map,
    normalMap: source.normalMap,
    roughnessMap: source.roughnessMap,
    metalnessMap: source.metalnessMap,
    roughness: 1,
    metalness: 1,
  });
  material.normalScale.copy(source.normalScale);
  material.name = `soldier-${team}`;
  const tint = TEAM_TINT[team];
  const packed = source.roughnessMap;
  if (packed) {
    // The packed map's red channel marks uniform cloth (see scripts/process-soldier.mjs).
    const cloth = texture(packed).r;
    const base = materialColor.rgb;
    const value = dot(base, vec3(0.2126, 0.7152, 0.0722));
    const dyed = color(tint.color).mul(value).mul(float(tint.gain));
    material.colorNode = mix(base, dyed, cloth.mul(tint.amount));
  }
  return material;
}
