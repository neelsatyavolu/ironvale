/**
 * viewmodel-export (M9 view-model lane, PLAN.md 5.2 and 5.4 layer 1). Runs the web's first-person
 * view model (src/weapons/view/rig.ts, gun-view.ts, parts.ts, poses.ts, motion.ts and
 * src/weapons/models/arms.ts with lib/guns-c-ik.ts) under Vitest on the gun-export GLBs
 * (native/MapPackages/guns, the finished GunModel scene graphs) and the real arms.glb, and writes:
 *   native/Contract/viewmodel.json                  constants the native view model reads at run time,
 *                                                   per-weapon poses and def fields, gun finish tables
 *   native/Contract/fixtures/viewmodel-poses.json   per weapon and scenario (idle, ads, fire, reload,
 *                                                   sprint, move): the frame inputs, the machine state
 *                                                   and events per frame, and at fixed frames the holder
 *                                                   pose, every animated part, the hand targets and every
 *                                                   arm bone's local transform
 * With VIEWMODEL_EXPORT_CHECK=1 it regenerates in memory and fails on any difference.
 * Run through ./viewmodel-export.sh [--check].
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import * as THREE from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { expect, it, vi } from 'vitest';
import type { Assets } from '../../../src/core/assets';
import type { GunModel, WeaponActionStage, WeaponDef } from '../../../src/game/contracts';
import { WEAPON_DEFS } from '../../../src/weapons/defs';
import { HANDLING, SPRINT_IN_SECONDS, SPRINT_OUT_SECONDS } from '../../../src/weapons/handling';
import { WeaponMachine, type MachineSink } from '../../../src/weapons/machine';
import { ARMS_ASSETS, buildArms } from '../../../src/weapons/models/arms';
import { WEAPON_IDS, type GunModule, type WeaponId } from '../../../src/weapons/models/api';
import { FINGER_CURLS, HAND, SHOULDERS, SUPPORT_BLEND_SECONDS, TUCK } from '../../../src/weapons/models/lib/guns-c-arms-pose';
import { GunView } from '../../../src/weapons/view/gun-view';
import { AGAINST_WALL, LOWERED, reloadPose, sprintPose, workPose } from '../../../src/weapons/view/poses';
import { ViewRig, type ViewFrame } from '../../../src/weapons/view/rig';
import type { World } from '../../../src/world/types';
import { extractConsts } from '../contract-export/extract-consts';

// The guns-c finish tables spread one finish into others, which the constant extractor cannot read:
// record every (source material, tweak) pair tunedFinish is called with while the gun modules build.
const captured = vi.hoisted(() => ({ finishes: new Map<string, Record<string, number>>() }));
vi.mock('../../../src/weapons/models/lib/guns-c-materials', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/weapons/models/lib/guns-c-materials')>();
  const three = await import('three/webgpu');
  return {
    ...original,
    tunedFinish: (source: THREE.Material, tweak: Record<string, number>) => {
      captured.finishes.set(source.name, { ...tweak });
      // The real material needs the source textures, which Node cannot decode; only the tweak matters here.
      return new three.MeshStandardMaterial({ name: `${source.name}_tuned` });
    },
  };
});

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const contractDir = resolve(repoRoot, 'native/Contract');
const gunsDir = resolve(repoRoot, 'native/MapPackages/guns');
const check = process.env.VIEWMODEL_EXPORT_CHECK === '1';

type Json = number | string | boolean | null | Json[] | { [key: string]: Json };

const v3 = (v: THREE.Vector3): number[] => [v.x, v.y, v.z];
const q4 = (q: THREE.Quaternion): number[] => [q.x, q.y, q.z, q.w];

// ---- Loading (textures stripped: Node has no image decoder) ----

async function loadStripped(path: string): Promise<GLTF> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.readBinary(new Uint8Array(readFileSync(resolve(repoRoot, path))));
  for (const texture of doc.getRoot().listTextures()) texture.dispose();
  for (const extension of doc.getRoot().listExtensionsUsed()) extension.dispose();
  const glb = await io.writeBinary(doc);
  const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
  return new Promise((resolveLoad, reject) => new GLTFLoader().parse(buffer, '', resolveLoad, reject));
}

interface GunMeta {
  id: string;
  cycleTravel: number;
  anchors: Record<string, string | null>;
}

/** The GunModel the web built, rebuilt from its gun-export scene graph and anchor names. */
async function loadGun(id: WeaponId): Promise<GunModel> {
  const meta = JSON.parse(readFileSync(resolve(gunsDir, `${id}.json`), 'utf8')) as GunMeta;
  const gltf = await loadStripped(`native/MapPackages/guns/${id}.glb`);
  if (gltf.scene.children.length !== 1) throw new Error(`${id}: the gun export must have one root node`);
  const root = gltf.scene.children[0]!;
  root.removeFromParent();
  const find = (role: string): THREE.Object3D | undefined => {
    const name = meta.anchors[role];
    if (!name) return undefined;
    const node = root.getObjectByName(name);
    if (!node) throw new Error(`${id}: anchor ${role} (${name}) is missing`);
    return node;
  };
  return {
    root,
    muzzle: find('muzzle')!,
    ejection: find('ejection')!,
    sight: find('sight')!,
    parts: {
      bolt: find('bolt'),
      slide: find('slide'),
      magazine: find('magazine'),
      trigger: find('trigger'),
      chargingHandle: find('chargingHandle'),
      cover: find('cover'),
    },
    cycleTravel: meta.cycleTravel,
    grips: { trigger: find('gripTrigger')!, support: find('gripSupport')! },
  };
}

// ---- Constants ----

/** Field initialisers the extractor cannot evaluate (`new Spring(k, d)`, `new THREE.Vector3(...)`), read by shape. */
function rigSourceConstants(): Record<string, Json> {
  const text = readFileSync(resolve(repoRoot, 'src/weapons/view/rig.ts'), 'utf8');
  const springs: Record<string, Json> = {};
  for (const name of ['kick', 'rise', 'cant', 'twist', 'drop', 'jolt']) {
    const match = new RegExp(`private readonly ${name} = new Spring\\(([-\\d.]+), ([-\\d.]+)\\);`).exec(text);
    if (!match) throw new Error(`rig.ts: spring ${name} not found; update viewmodel-export`);
    springs[name] = [Number(match[1]), Number(match[2])];
  }
  const shoulder = /const SHOULDER = new THREE\.Vector3\(([-\d.]+), ([-\d.]+), ([-\d.]+)\);/.exec(text);
  if (!shoulder) throw new Error('rig.ts: SHOULDER not found; update viewmodel-export');
  return { springs, SHOULDER: [Number(shoulder[1]), Number(shoulder[2]), Number(shoulder[3])] };
}

function defFields(def: WeaponDef): Json {
  return {
    weaponClass: def.weaponClass,
    fireMode: def.fireMode,
    reloadStyle: def.reloadStyle,
    scoped: def.scoped,
    aimTime: def.aimTime,
    aimZoom: def.aimZoom,
    recoil: { kickback: def.recoil.kickback, vertical: def.recoil.vertical, horizontal: def.recoil.horizontal },
  };
}

async function finishTables(): Promise<Json> {
  // Building the guns-c modules runs the mocked tunedFinish once per source material.
  const modules: Record<string, string> = { m4a1: 'mdl-gun-m4a1', m249: 'mdl-gun-m249', scarh: 'mdl-gun-scarh' };
  const tuned: Record<string, Json> = {};
  for (const [id, asset] of Object.entries(modules)) {
    const gltf = await loadStripped(`public/assets/local/guns/${id}.glb`);
    const assets = { model: (key: string) => (key === asset ? gltf.scene.clone(true) : null), gltf: () => gltf } as unknown as Assets;
    captured.finishes.clear();
    const module = (await import(`../../../src/weapons/models/${id}.gun.ts`)) as { default: GunModule };
    module.default.build(assets);
    const materials: Record<string, Json> = {};
    for (const [name, tweak] of [...captured.finishes.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      materials[`${name}_tuned`] = { source: name, ...tweak };
    }
    tuned[id] = materials;
  }
  const m7 = extractConsts(repoRoot, 'src/weapons/models/lib/m7-materials.ts', ['FINISHES']).FINISHES as Record<string, Json>;
  const m7Finishes = Object.fromEntries(Object.entries(m7).map(([name, finish]) => [`${name}_finish`, finish]));
  return { tuned, m7: m7Finishes };
}

async function constantsTable(): Promise<Json> {
  const weapons: Record<string, Json> = {};
  for (const id of WEAPON_IDS) {
    const def = WEAPON_DEFS[id];
    weapons[id] = { ...(defFields(def) as Record<string, Json>), sprintPose: { ...sprintPose(def) }, reloadPose: { ...reloadPose(def) }, workPose: { ...workPose(def) } };
  }
  return {
    rig: {
      ...(extractConsts(repoRoot, 'src/weapons/view/rig.ts', [
        'RUN_SPEED', 'STRIDE', 'MAX_TURN_RATE', 'SWAY_ROTATION', 'SWAY_SHIFT', 'AIMED_SWAY', 'AIMED_BOB', 'AIMED_RISE',
        'KICK_IMPULSE', 'WALL_MARGIN', 'WALL_MAX_ANGLE', 'VIEW_MODEL_FOV',
      ]) as Record<string, Json>),
      ...rigSourceConstants(),
    },
    motion: extractConsts(repoRoot, 'src/weapons/view/motion.ts', ['MAX_SPRING_STEP']) as Json,
    parts: extractConsts(repoRoot, 'src/weapons/view/parts.ts', [
      'SLIDE_BACK_SECONDS', 'SLIDE_RETURN_SECONDS', 'MAG_DROP_METRES', 'MAG_TOWARD_SHOOTER', 'MAG_FALL_SECONDS', 'MAG_SEAT_SECONDS',
      'BOLT_LIFT_RADIANS', 'COVER_OPEN_RADIANS', 'TRIGGER_PULL_RADIANS', 'TRIGGER_HOLD_SECONDS', 'TRIGGER_RELEASE_SECONDS',
      'WEIGHT_RATE', 'RELEASE_RATE',
    ]) as Json,
    poses: { lowered: { ...LOWERED }, againstWall: { ...AGAINST_WALL } },
    handling: Object.fromEntries(Object.entries(HANDLING).map(([k, h]) => [k, { hip: [...h.hip], hipTilt: [...h.hipTilt] }])),
    sprint: { inSeconds: SPRINT_IN_SECONDS, outSeconds: SPRINT_OUT_SECONDS },
    arms: {
      asset: ARMS_ASSETS[0],
      ...(extractConsts(repoRoot, 'src/weapons/models/arms.ts', ['SOURCE_SCALE', 'FINGERS']) as Record<string, Json>),
      shoulders: SHOULDERS as unknown as Json,
      hand: { ...HAND },
      fingerCurls: FINGER_CURLS as unknown as Json,
      tuck: TUCK as unknown as Json,
      supportBlendSeconds: SUPPORT_BLEND_SECONDS,
      ...(extractConsts(repoRoot, 'src/weapons/models/lib/guns-c-ik.ts', ['EPSILON']) as Record<string, Json>),
    },
    weapons,
    finishes: await finishTables(),
    reticle: extractConsts(repoRoot, 'src/weapons/models/lib/guns-c-optic.ts', ['RETICLE']).RETICLE as Json,
  };
}

// ---- Scenarios ----

const DT = 1 / 60;
const BASE_FOV = 78;

interface FrameInput {
  aim: number;
  sprint: number;
  lowered: number;
  speed: number;
  verticalSpeed: number;
  onGround: boolean;
  lookYaw: number;
  lookPitch: number;
  fov: number;
  fireHeld: boolean;
  firePressed: boolean;
  reloadPressed: boolean;
  landed: number;
  wall: number;
}

type Scenario = 'idle' | 'ads' | 'fire' | 'reload' | 'sprint' | 'move';
const SCENARIOS: readonly Scenario[] = ['idle', 'ads', 'fire', 'reload', 'sprint', 'move'];

function fovForZoom(baseFov: number, zoom: number): number {
  const half = Math.tan(THREE.MathUtils.degToRad(baseFov / 2)) * zoom;
  return THREE.MathUtils.radToDeg(2 * Math.atan(half));
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Scripted inputs for one frame. Everything is a closed form of the frame index, so the script is the fixture. */
function input(scenario: Scenario, def: WeaponDef, frame: number, frames: number): FrameInput {
  const t = frame * DT;
  const base: FrameInput = {
    aim: 0, sprint: 0, lowered: 0, speed: 0, verticalSpeed: 0, onGround: true, lookYaw: 0, lookPitch: 0, fov: BASE_FOV,
    fireHeld: false, firePressed: false, reloadPressed: false, landed: 0, wall: 0,
  };
  switch (scenario) {
    case 'idle':
      return { ...base, lookYaw: 0.02 * Math.sin(t * 2.3), lookPitch: -0.012 * Math.sin(t * 1.7 + 0.4) };
    case 'ads': {
      const aim = Math.min(1, Math.max(0, (t - 0.1) / def.aimTime));
      return { ...base, aim, fov: fovForZoom(BASE_FOV, THREE.MathUtils.lerp(1, def.aimZoom, smooth(aim))), lookYaw: 0.006 * Math.sin(t * 3.1) };
    }
    case 'fire': {
      const auto = def.fireMode === 'auto';
      const press = !auto && frame % 24 === 2;
      return { ...base, aim: frame > frames / 2 ? 1 : 0, fireHeld: auto ? frame >= 2 && frame < 40 : press, firePressed: press || (auto && frame === 2) };
    }
    case 'reload':
      return { ...base, firePressed: frame === 1, fireHeld: frame === 1, reloadPressed: frame === 30, lookYaw: 0.01 * Math.sin(t * 1.9) };
    case 'sprint': {
      const into = Math.min(1, t / SPRINT_IN_SECONDS);
      const out = t > 1.2 ? Math.max(0, 1 - (t - 1.2) / SPRINT_OUT_SECONDS) : 1;
      return { ...base, sprint: Math.min(into, out), speed: t < 1.2 ? 6.4 : 3, lookYaw: 0.03 * Math.sin(t * 2.9) };
    }
    case 'move': {
      // Walk, jump and land, a weapon switch dip, then the barrel up against a wall.
      const air = t > 0.5 && t < 1.1;
      const lowered = t > 1.3 && t < 1.9 ? Math.sin(((t - 1.3) / 0.6) * Math.PI) : 0;
      return {
        ...base, speed: 3.2, onGround: !air, verticalSpeed: air ? 4.5 - 9.8 * (t - 0.5) : 0, landed: frame === 66 ? 7.5 : 0,
        lowered, wall: t > 2 ? 0.32 : 0, lookPitch: 0.02 * Math.sin(t * 2.2),
      };
    }
  }
}

function frameCount(scenario: Scenario, machine: WeaponMachine, def: WeaponDef): number {
  switch (scenario) {
    case 'reload': {
      const longest = Math.max(...[true, false].map((chambered) => reloadDuration(def, chambered)));
      return 30 + Math.ceil(longest / DT) + 30;
    }
    case 'fire':
      return 150;
    case 'move':
      return 180;
    default:
      return 120;
  }
  void machine;
}

function reloadDuration(def: WeaponDef, chambered: boolean): number {
  // The plans module is the source of truth; reloadPlan durations bound the scenario length.
  return reloadPlanOf(def, chambered).duration;
}

let reloadPlanOf: (def: WeaponDef, chambered: boolean) => { duration: number };

/** Every Object3D state the native rig must reproduce. */
function sample(rig: ViewRig, gun: GunView, model: GunModel, arms: THREE.Object3D | null, bones: THREE.Object3D[]): Json {
  const holder = model.root.parent!;
  const parts: Record<string, Json> = {};
  for (const [name, part] of Object.entries(model.parts)) {
    if (!part) continue;
    parts[name] = { position: v3(part.position), quaternion: q4(part.quaternion), visible: part.visible };
  }
  const muzzle = new THREE.Vector3();
  rig.muzzleWorld(muzzle);
  const port = new THREE.Vector3();
  const side = new THREE.Vector3();
  rig.ejectionWorld(port, side);
  return {
    holder: { position: v3(holder.position), quaternion: q4(holder.quaternion) },
    rootScaleZ: rig.root.scale.z,
    visible: rig.root.visible,
    parts,
    tilt: gun.parts.tilt,
    work: gun.parts.work,
    seat: gun.parts.seat,
    supportAway: gun.parts.supportAway,
    triggerAway: gun.parts.triggerAway,
    magazineOut: gun.parts.magazineOut,
    triggerTarget: { position: v3(gun.triggerTarget.position), quaternion: q4(gun.triggerTarget.quaternion) },
    supportTarget: { position: v3(gun.supportTarget.position), quaternion: q4(gun.supportTarget.quaternion) },
    muzzle: v3(muzzle),
    ejection: { position: v3(port), direction: v3(side) },
    bones: arms ? bones.map((bone) => [...v3(bone.position), ...q4(bone.quaternion)]) : [],
  };
}

function actionJson(machine: WeaponMachine): Json {
  const action = machine.action;
  if (!action) return null;
  return {
    kind: action.kind,
    duration: action.duration,
    handsFrom: action.handsFrom,
    handsTo: action.handsTo,
    marks: action.marks.map((mark) => ({ time: mark.time, stage: mark.stage ?? null })),
  };
}

async function runScenario(id: WeaponId, scenario: Scenario, armsGltf: GLTF): Promise<Json> {
  const def = WEAPON_DEFS[id];
  const model = await loadGun(id);
  const assets = { gltf: (key: string) => (key === ARMS_ASSETS[0] ? armsGltf : null) } as unknown as Assets;
  const arms = buildArms(assets);
  const camera = new THREE.PerspectiveCamera(BASE_FOV, 16 / 10, 0.04, 900);
  const rig = new ViewRig(camera, arms);
  const gun = new GunView(model, def);
  rig.show(gun);
  const machine = new WeaponMachine(def);
  let wall = 0;
  const world = {
    raycast: (_origin: THREE.Vector3, _direction: THREE.Vector3, far: number) => (wall > 0 && wall <= far ? { distance: wall } : null),
  } as unknown as World;

  const bones: THREE.Object3D[] = [];
  arms.root.traverse((child) => {
    if ((child as THREE.Bone).isBone) bones.push(child);
  });
  let skinned: THREE.SkinnedMesh | null = null;
  arms.root.traverse((child) => {
    if ((child as THREE.SkinnedMesh).isSkinnedMesh) skinned = child as THREE.SkinnedMesh;
  });

  let currentAim = 0;
  let shot = 0;
  const events: Json[] = [];
  const sink: MachineSink = {
    fire: () => {
      // Deterministic stand-in for recoil.kickYaw / horizontal: alternating sides of varying size.
      const side = [0.6, -0.35, 0.9, -0.8, 0.15][shot % 5]!;
      shot += 1;
      rig.fired(currentAim, side);
      events.push({ fired: { aim: currentAim, side } });
    },
    dryFire: () => undefined,
    stage: (stage: WeaponActionStage) => {
      rig.stage(stage);
      events.push({ stage });
    },
    eject: () => undefined,
  };

  const frames = frameCount(scenario, machine, def);
  const sampleEvery = scenario === 'reload' ? 15 : 10;
  const inputs: Json[] = [];
  const samples: Json[] = [];
  const frame: ViewFrame = {
    dt: DT, machine, aim: 0, sprint: 0, lowered: 0, speed: 0, verticalSpeed: 0, onGround: true, lookYaw: 0, lookPitch: 0, hidden: false,
  };
  for (let f = 0; f < frames; f++) {
    const step = input(scenario, def, f, frames);
    events.length = 0;
    currentAim = step.aim;
    camera.fov = step.fov;
    camera.updateProjectionMatrix();
    wall = step.wall;
    if (step.landed > 0) {
      rig.landed(step.landed);
      events.push({ landed: step.landed });
    }
    machine.step(DT, { fireHeld: step.fireHeld, firePressed: step.firePressed, reloadPressed: step.reloadPressed, ready: true }, sink);
    Object.assign(frame, {
      aim: step.aim, sprint: step.sprint, lowered: step.lowered, speed: step.speed, verticalSpeed: step.verticalSpeed,
      onGround: step.onGround, lookYaw: step.lookYaw, lookPitch: step.lookPitch, hidden: false,
    });
    rig.update(frame, world);
    inputs.push({
      ...step,
      events: [...events],
      machine: { action: actionJson(machine), actionTime: machine.actionTime, chambered: machine.chambered, magazine: machine.magazine },
    } as unknown as Json);
    if (f % sampleEvery === sampleEvery - 1 || f === frames - 1) samples.push({ frame: f, ...(sample(rig, gun, model, arms.root, bones) as Record<string, Json>) });
  }
  const bindMatrix = skinned ? (skinned as THREE.SkinnedMesh).bindMatrix.toArray() : null;
  return { frames, dt: DT, inputs, samples, boneNames: bones.map((bone) => bone.name), bindMatrix };
}

// ---- Output ----

/** Stable JSON: floats as JS prints them, two-space indents, one fixture frame per line. */
function canonical(value: Json): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function fixtureText(value: Record<string, Json>): string {
  const lines = Object.entries(value).map(([key, item]) => `  ${JSON.stringify(key)}: ${JSON.stringify(item)}`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

it('exports the view model constants and rig pose fixtures', async () => {
  const plans = await import('../../../src/weapons/plans');
  reloadPlanOf = plans.reloadPlan;
  const armsGltf = await loadStripped('public/assets/local/guns/arms.glb');
  const fixtures: Record<string, Json> = {};
  for (const id of WEAPON_IDS) {
    const perWeapon: Record<string, Json> = {};
    for (const scenario of SCENARIOS) perWeapon[scenario] = await runScenario(id, scenario, armsGltf);
    fixtures[id] = perWeapon;
  }
  const outputs: Record<string, string> = {
    'viewmodel.json': canonical(await constantsTable()),
    'fixtures/viewmodel-poses.json': fixtureText(fixtures),
  };
  if (check) {
    const stale = Object.entries(outputs).filter(([name, text]) => {
      const path = resolve(contractDir, name);
      return !existsSync(path) || readFileSync(path, 'utf8') !== text;
    });
    expect(stale.map(([name]) => name), 'native/Contract view model files are out of date; run native/Tools/viewmodel-export/viewmodel-export.sh').toEqual([]);
    return;
  }
  for (const [name, text] of Object.entries(outputs)) {
    const path = resolve(contractDir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
});
