/**
 * characters-export (M7a, PLAN.md 5.2 and 5.4 layer 1). Runs the web's src/characters modules
 * under Vitest and writes:
 *   native/Contract/characters.json           constants the native soldier reads at run time
 *   native/Contract/fixtures/characters.json  input -> output cases for pose, IK, gun hold,
 *                                             locomotion, death, reactions, LOD, the rig and
 *                                             whole-soldier scenarios on the real soldier.glb
 * With CHARACTERS_EXPORT_CHECK=1 it regenerates in memory and fails on any difference.
 * Run through ./characters-export.sh [--check].
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import * as THREE from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { expect, it } from 'vitest';
import { CARBINE_POINTS } from '../../../src/characters/carbine-meta';
import { ANKLE_HEIGHT, CLIP_BONES, CLIP_FPS, CLIP_META } from '../../../src/characters/clip-meta';
import { DEATH, deathFrame, planDeath, type DeathFrame } from '../../../src/characters/death';
import { CARBINE, GunHold, SIGHT, type HoldInput } from '../../../src/characters/gun-hold';
import { calibrateArm, createArmSolution, quatFromBasis, solveArm, type ArmRest } from '../../../src/characters/ik';
import { LOD, VisibilityTracker, poseInterval, shouldPose } from '../../../src/characters/lod';
import { GAIT_CLIPS, advancePhase, clipTimeAtPhase, createGaitWeights, cycleLength, gaitWeights, resolveHeading } from '../../../src/characters/locomotion';
import { Pose, blendPose, buildClipData, sampleClip, steerBone } from '../../../src/characters/pose';
import { Flinch, Recoil, flinchEnvelope } from '../../../src/characters/reactions';
import { CARBINE_ASSET, SOLDIER_ASSET, soldierRig, type SoldierRig } from '../../../src/characters/rig';
import { Soldier } from '../../../src/characters/soldier';
import type { Assets } from '../../../src/core/assets';
import { extractConsts } from '../contract-export/extract-consts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const contractDir = resolve(repoRoot, 'native/Contract');
const check = process.env.CHARACTERS_EXPORT_CHECK === '1';

type Json = number | string | boolean | null | Json[] | { [key: string]: Json };

const v3 = (v: THREE.Vector3): number[] => [v.x, v.y, v.z];
const q4 = (q: THREE.Quaternion): number[] => [q.x, q.y, q.z, q.w];
const num = (value: number): Json => (Number.isFinite(value) ? value : value > 0 ? 'Infinity' : value < 0 ? '-Infinity' : 'NaN');

// ---- Loading the real soldier through three's GLTFLoader (textures stripped: Node has no image decoder) ----

async function loadStripped(path: string): Promise<GLTF> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.readBinary(new Uint8Array(readFileSync(resolve(repoRoot, path))));
  for (const texture of doc.getRoot().listTextures()) texture.dispose();
  for (const extension of doc.getRoot().listExtensionsUsed()) extension.dispose();
  const glb = await io.writeBinary(doc);
  const buffer = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
  return new Promise((resolveLoad, reject) => new GLTFLoader().parse(buffer, '', resolveLoad, reject));
}

async function loadRig(): Promise<SoldierRig> {
  const soldier = await loadStripped('public/assets/local/characters/soldier.glb');
  const carbine = await loadStripped('public/assets/local/characters/carbine.glb');
  const assets = { gltf: (id: string) => (id === SOLDIER_ASSET ? soldier : id === CARBINE_ASSET ? carbine : null) } as unknown as Assets;
  return soldierRig(assets);
}

// ---- Constants ----

function constantsTable(): Json {
  const extracted = {
    ...extractConsts(repoRoot, 'src/characters/soldier.ts', ['TUNING', 'SPINE_SHARE']),
    ...extractConsts(repoRoot, 'src/characters/rig.ts', ['TEAM_TINT', 'FINGER_CURL', 'THUMB_FOLD']),
    ...extractConsts(repoRoot, 'src/characters/reactions.ts', ['FLINCH_RISE', 'SHOT_INTERVAL', 'RECOIL_DECAY']),
    ...extractConsts(repoRoot, 'src/characters/ik.ts', ['PALM_FORWARD', 'PALM_DEPTH', 'FOREARM_TWIST_SHARE', 'MAX_REACH']),
    ...extractConsts(repoRoot, 'src/characters/locomotion.ts', ['MAX_CADENCE', 'MAX_HIP_YAW', 'REVERSE_ANGLE', 'REVERSE_HYSTERESIS']),
    ...extractConsts(repoRoot, 'src/characters/death.ts', ['GRAVITY', 'DROP_SPEED', 'REST_HEIGHT']),
  };
  const grip = (g: { position: THREE.Vector3; fingers: THREE.Vector3; thumb: THREE.Vector3 }) => ({ position: v3(g.position), fingers: v3(g.fingers), thumb: v3(g.thumb) });
  return {
    clipFps: CLIP_FPS,
    clipMeta: CLIP_META as unknown as Json,
    clipBones: [...CLIP_BONES],
    ankleHeight: ANKLE_HEIGHT,
    carbinePoints: CARBINE_POINTS as unknown as Json,
    carbine: { muzzle: v3(CARBINE.muzzle), butt: v3(CARBINE.butt), trigger: grip(CARBINE.trigger), support: grip(CARBINE.support), magazine: grip(CARBINE.magazine) },
    sight: { ...SIGHT },
    death: DEATH as unknown as Json,
    lod: { ...LOD },
    ...(extracted as Record<string, Json>),
  };
}

// ---- Pure-module fixtures ----

const yaw = (angle: number) => [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];

function poseFixtures(rig: SoldierRig): Json {
  const bones = CLIP_BONES.length;
  const sampled: Json[] = [];
  for (const name of Object.keys(CLIP_META) as (keyof typeof CLIP_META)[]) {
    for (const time of [-1.3, 0, 0.0123, 0.25, 0.51, 1, CLIP_META[name].duration, CLIP_META[name].duration + 0.37, 7.77]) {
      const pose = new Pose(bones);
      sampleClip(rig.clips[name], time, pose);
      sampled.push({ clip: name, time, rotations: Array.from(pose.rotations), hips: Array.from(pose.hips) });
    }
  }
  const blends: Json[] = [];
  for (const [a, b, w] of [['idle', 'walk', 0.3], ['run', 'jog', 0.77], ['crouchIdle', 'death', 1], ['walk', 'deathFront', 0]] as const) {
    const out = new Pose(bones);
    const other = new Pose(bones);
    sampleClip(rig.clips[a], 0.4, out);
    sampleClip(rig.clips[b], 0.9, other);
    blendPose(out, other, w);
    blends.push({ a, b, timeA: 0.4, timeB: 0.9, weight: w, rotations: Array.from(out.rotations), hips: Array.from(out.hips) });
  }
  const steer: Json[] = [];
  for (const weight of [0, 0.25, 0.8, 1]) {
    const pose = new Pose(2);
    pose.rotations.set([...yaw(1), ...yaw(-2.5)]);
    steerBone(pose, 1, { x: 0.1, y: -0.2, z: 0.3, w: -0.9 }, weight);
    steer.push({ weight, rotations: Array.from(pose.rotations) });
  }
  // The web test's synthetic clip, built from tracks.
  const frames = [0, 0.4, 0.8];
  const synthetic = (loop: boolean) =>
    buildClipData({
      bones: ['A', 'B'],
      fps: 2,
      loop,
      tracks: [
        { name: 'A.quaternion', values: new Float32Array(frames.flatMap(yaw)) },
        { name: 'B.quaternion', values: new Float32Array(frames.flatMap(() => yaw(0.1))) },
        { name: 'Hips.position', values: new Float32Array(frames.flatMap((_, i) => [0, i, 0])) },
      ],
    });
  const syntheticCases: Json[] = [];
  for (const loop of [false, true]) {
    const clip = synthetic(loop);
    for (const time of [-1, 0, 0.25, 0.5, 1.25, 2, 99]) {
      const pose = new Pose(2);
      sampleClip(clip, time, pose);
      syntheticCases.push({ loop, duration: clip.duration, time, rotations: Array.from(pose.rotations), hips: Array.from(pose.hips) });
    }
  }
  return {
    sampled,
    blends,
    steer,
    synthetic: { fps: 2, rotations: Array.from(synthetic(true).rotations), hips: Array.from(synthetic(true).hips), cases: syntheticCases },
  };
}

function locomotionFixtures(): Json {
  const weights: Json[] = [];
  for (const crouch of [-0.5, 0, 0.3, 0.5, 1, 1.4]) {
    for (let i = 0; i <= 90; i++) {
      const speed = i * 0.09 - 0.2;
      const w = gaitWeights(speed, crouch, createGaitWeights());
      weights.push({ speed, crouch, weights: GAIT_CLIPS.map((clip) => w[clip]), cycle: num(cycleLength(w)) });
    }
  }
  const phases: Json[] = [];
  for (const [phase, speed, crouch, dt, reverse] of [
    [0, 1.7, 0, 1 / 60, false], [0.3, 0, 0, 0.016, false], [0.001, 1.7, 0, 0.05, true], [0, 30, 0, 0.1, false],
    [0.95, 5.6, 0, 0.033, false], [0.5, 2.35, 0.2, 0.02, true], [0.2, 1.8, 1, 0.1, false], [0.7, 0.6, 1, 0.016, true],
  ] as const) {
    const w = gaitWeights(speed, crouch, createGaitWeights());
    phases.push({ phase, speed, crouch, dt, reverse, out: advancePhase(phase, speed, w, dt, reverse) });
  }
  const clipTimes: Json[] = [];
  for (const clip of ['walk', 'jog', 'run', 'crouchWalk', 'crouchJog'] as const) {
    for (const phase of [0, 0.1, 0.5, 0.95, 0.9999]) clipTimes.push({ clip, phase, time: clipTimeAtPhase(clip, phase) });
  }
  const headings: Json[] = [];
  for (let deg = -400; deg <= 400; deg += 7) {
    for (const was of [false, true]) {
      const h = resolveHeading((deg * Math.PI) / 180, was);
      headings.push({ angle: (deg * Math.PI) / 180, wasReverse: was, hipYaw: h.hipYaw, reverse: h.reverse });
    }
  }
  return { clips: [...GAIT_CLIPS], weights, phases, clipTimes, headings };
}

function deathFixtures(): Json {
  const plans: Json[] = [];
  for (let deg = 0; deg < 360; deg += 5) {
    const x = Math.sin((deg * Math.PI) / 180) * 0.8;
    const z = Math.cos((deg * Math.PI) / 180) * 0.8;
    const plan = planDeath(x, z);
    plans.push({ x, z, variant: plan.variant, turn: plan.turn });
  }
  plans.push({ x: 0, z: 0, ...planDeath(0, 0) });
  const frames: Json[] = [];
  for (const variant of ['back', 'front'] as const) {
    for (const elapsed of [-0.5, 0, 0.05, 0.1, 0.14, 0.16, 0.3, 0.4, 0.9, 1.2, 1.5, 1.7, 3, 10]) {
      const f: DeathFrame = deathFrame(variant, elapsed, { clipTime: 0, blend: 0, ikWeight: 1, turn: 0, settled: false });
      frames.push({ variant, elapsed, ...f });
    }
  }
  return { plans, frames };
}

function reactionFixtures(): Json {
  const envelope = [-1, 0, 0.01, 0.065, 0.1, 0.3, 0.5, 2].map((t) => ({ time: t, value: flinchEnvelope(t) }));
  const flinches: Json[] = [];
  for (const zone of ['head', 'torso', 'limb'] as const) {
    const flinch = new Flinch();
    const steps: Json[] = [];
    for (let i = 0; i < 70; i++) {
      if (i === 0 || i === 20) flinch.hit(zone);
      flinch.update(i % 9 === 0 ? 1 / 30 : 1 / 60);
      steps.push([flinch.headPitch, flinch.headYaw, flinch.torsoPitch, flinch.torsoYaw, flinch.hipsPitch, flinch.hipsRoll, flinch.gunDip, flinch.active]);
    }
    flinches.push({ zone, hits: [0, 20], steps });
  }
  const recoil = new Recoil();
  const recoilSteps: Json[] = [];
  for (let i = 0; i < 120; i++) {
    const dt = i === 50 ? 2 : i % 7 === 0 ? 1 / 30 : 1 / 60;
    const firing = i < 40 || (i >= 50 && i < 90);
    recoil.update(dt, firing);
    recoilSteps.push({ dt, firing, value: recoil.value, side: recoil.side });
  }
  return { envelope, flinches, recoil: recoilSteps };
}

function lodFixtures(): Json {
  const intervals: Json[] = [];
  for (const visible of [true, false]) for (const distance of [0, 5, 28, 28.01, 45, 60, 60.5, 500]) intervals.push({ visible, distance, interval: poseInterval(visible, distance) });
  const should: Json[] = [];
  for (const interval of [1, 2, 3, 6]) for (let slot = 0; slot < 7; slot++) for (let frame = 0; frame < 13; frame++) should.push([frame, slot, interval, shouldPose(frame, slot, interval)]);
  const tracker = new VisibilityTracker();
  const visibility: Json[] = [];
  for (let i = 0; i < 12; i++) {
    if (i === 2 || i === 9) tracker.seen(10 + i);
    tracker.tick();
    visibility.push([tracker.visible, tracker.distance]);
  }
  return { intervals, should, visibility };
}

function restArm(): ArmRest {
  const odd = (x: number, y: number, z: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(x, y, z).normalize(), 0.9);
  return {
    side: 'right',
    upper: { q: odd(1, 2, 0.3), p: new THREE.Vector3(0.2, 1.45, 0) },
    lower: { q: odd(0.2, -1, 0.5), p: new THREE.Vector3(0.45, 1.45, 0) },
    hand: { q: odd(-0.4, 0.3, 1), p: new THREE.Vector3(0.73, 1.45, 0) },
    fingers: new THREE.Vector3(0.82, 1.45, 0),
    thumb: new THREE.Vector3(0.77, 1.45, -0.04),
  };
}

function setupJson(setup: ReturnType<typeof calibrateArm>): Json {
  return {
    upperLength: setup.upperLength,
    lowerLength: setup.lowerLength,
    upperOffset: q4(setup.upperOffset),
    lowerOffset: q4(setup.lowerOffset),
    handOffset: q4(setup.handOffset),
    palmLocal: v3(setup.palmLocal),
    lowerAxis: v3(setup.lowerAxis),
    handRest: q4(setup.handRest),
  };
}

function ikFixtures(): Json {
  const bases: Json[] = [];
  for (const [x, y] of [[[1, 0, 0], [0, 1, 0]], [[0, 1, 0], [0, 0, -1]], [[0.3, -0.2, 0.9], [0.5, 0.5, 0.1]], [[-2, 1, 0.5], [0.1, -1, 3]]] as const) {
    bases.push({ x: [...x], y: [...y], q: q4(quatFromBasis(new THREE.Vector3(...x), new THREE.Vector3(...y), new THREE.Quaternion())) });
  }
  const arms: Json[] = [];
  for (const side of ['right', 'left'] as const) {
    const rest = { ...restArm(), side };
    const setup = calibrateArm(rest);
    const solves: Json[] = [];
    const shoulder = new THREE.Vector3(0.18, 1.4, 0.05);
    const pole = new THREE.Vector3(0.5, -0.8, 0.3).normalize();
    const grips: [number[], number[], number][] = [
      [[0.12, 1.3, -0.3], [0, 0, 1], 0],
      [[0.12, 1.3, -0.3], [0, 0, 1], 1.2],
      [[0.2, 1.4, -3], [1, 0, 0], 0.4],
      [[0.18, 1.4, 0.05], [0, 1, 0], -0.7],
      [[-0.1, 1.1, -0.2], [0.3, 0.4, 0.5], 2.5],
    ];
    for (const [position, axis, angle] of grips) {
      const rotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(), angle);
      for (const poleCase of [pole, new THREE.Vector3(0, 0, 0)]) {
        const out = createArmSolution();
        solveArm(setup, shoulder, new THREE.Vector3(...position), rotation, poleCase, out);
        solves.push({ grip: position, rotation: q4(rotation), pole: v3(poleCase), upper: q4(out.upper), lower: q4(out.lower), hand: q4(out.hand), elbow: v3(out.elbow), wrist: v3(out.wrist) });
      }
    }
    arms.push({
      rest: { side, upper: [...q4(rest.upper.q), ...v3(rest.upper.p)], lower: [...q4(rest.lower.q), ...v3(rest.lower.p)], hand: [...q4(rest.hand.q), ...v3(rest.hand.p)], fingers: v3(rest.fingers), thumb: v3(rest.thumb) },
      setup: setupJson(setup),
      shoulder: v3(shoulder),
      solves,
    });
  }
  return { bases, arms };
}

function gunHoldFixtures(): Json {
  const shoulder = new THREE.Vector3(0.17, 1.45, 0.05);
  const base: HoldInput = { aim: 1, carry: 0, pitch: 0, recoil: 0, recoilSide: 0, reload: -1, swayPitch: 0, swayYaw: 0 };
  const inputs: Partial<HoldInput>[] = [
    {}, { aim: 0 }, { aim: 0.5 }, { aim: 1, carry: 1 }, { aim: 0, carry: 0.6 }, { pitch: -0.6 }, { pitch: 0.9, recoil: 1, recoilSide: -0.7 },
    { aim: 0, reload: 0 }, { aim: 0, reload: 0.1 }, { aim: 0, reload: 0.5 }, { aim: 0.3, reload: 0.8 }, { aim: 0, reload: 1 },
    { swayPitch: 0.012, swayYaw: -0.01 },
  ];
  const eyes: (number[] | null)[] = [null, [0.13, 1.62, -0.02], [0.4, 1.9, 0.2]];
  const cases: Json[] = [];
  for (const over of inputs) {
    for (const eye of eyes) {
      const input = { ...base, ...over };
      const hold = new GunHold();
      hold.update(shoulder, input, eye ? new THREE.Vector3(...eye) : undefined);
      cases.push({
        input: [input.aim, input.carry, input.pitch, input.recoil, input.recoilSide, input.reload, input.swayPitch, input.swayYaw],
        eye,
        position: v3(hold.position),
        quaternion: q4(hold.quaternion),
        trigger: [...v3(hold.triggerPosition), ...q4(hold.triggerRotation)],
        support: [...v3(hold.supportPosition), ...q4(hold.supportRotation)],
      });
    }
  }
  return { shoulder: v3(shoulder), cases };
}

function rigFixtures(rig: SoldierRig): Json {
  const arm = (a: SoldierRig['arms']['left']) => ({ setup: setupJson(a.setup), shoulder: a.shoulder, upper: a.upper, lower: a.lower, hand: a.hand });
  return {
    parents: [...rig.parents],
    offsets: rig.offsets.map(v3),
    restLocal: rig.restLocal.map(q4),
    restModel: rig.restModel.map(q4),
    fingers: rig.fingers.map((f) => ({ name: f.name, grip: q4(f.grip) })),
    arms: { left: arm(rig.arms.left), right: arm(rig.arms.right) },
  };
}

// ---- Whole-soldier scenarios ----

interface Step {
  readonly dt: number;
  readonly speed: number;
  readonly crouching: boolean;
  readonly aimPitch: number;
  readonly aiming: boolean;
  readonly firing: boolean;
  readonly reloading: boolean;
  /** World velocity of the root this step, and its yaw. */
  readonly vx: number;
  readonly vz: number;
  readonly yaw: number;
  readonly flinch?: 'head' | 'torso' | 'limb';
  readonly die?: [number, number, number];
  readonly revive?: boolean;
}

function scenarioSteps(kind: 'alive' | 'death'): Step[] {
  const steps: Step[] = [];
  const count = kind === 'alive' ? 720 : 420;
  for (let i = 0; i < count; i++) {
    const t = i / 60;
    const dt = i === 333 ? 0.25 : i % 11 === 0 ? 1 / 30 : 1 / 60;
    const yaw = 0.6 * Math.sin(t * 0.7) + (kind === 'death' ? 2.2 : 0);
    let speed = 0;
    let dir = 0; // travel direction relative to the facing, radians, positive left
    let crouching = false;
    let aiming = false;
    let firing = false;
    let reloading = false;
    if (kind === 'alive') {
      if (t < 1) speed = 0;
      else if (t < 4) speed = (t - 1) * 2;
      else if (t < 5) { speed = 6; }
      else if (t < 6.5) { speed = 2.6; dir = Math.PI / 2; aiming = true; firing = t > 5.4 && t < 6; }
      else if (t < 8) { speed = 1.7; dir = Math.PI * 0.95; aiming = true; }
      else if (t < 9.5) { speed = 1.8; crouching = true; dir = -0.4; reloading = t > 8.5; }
      else if (t < 10.5) { speed = 0; crouching = true; aiming = true; firing = t > 9.8 && t < 10.1; }
      else { speed = 3.4; dir = 0.3; }
    } else {
      speed = t < 1 ? 3.4 : 0;
      aiming = t >= 1;
      firing = t > 1.2 && t < 1.4;
    }
    const heading = yaw + dir;
    const step: Step = {
      dt, speed, crouching, aiming, firing, reloading, yaw,
      aimPitch: 0.5 * Math.sin(t * 1.3) - 0.1,
      vx: -Math.sin(heading) * speed,
      vz: -Math.cos(heading) * speed,
      ...(kind === 'alive' && i === 130 ? { flinch: 'head' as const } : {}),
      ...(kind === 'alive' && i === 400 ? { flinch: 'torso' as const } : {}),
      ...(kind === 'alive' && i === 560 ? { flinch: 'limb' as const } : {}),
      ...(kind === 'death' && i === 90 ? { die: [0.6, -0.1, 0.8] as [number, number, number] } : {}),
      ...(kind === 'death' && i === 240 ? { revive: true } : {}),
      ...(kind === 'death' && i === 300 ? { die: [-0.5, 0, -0.9] as [number, number, number] } : {}),
    };
    steps.push(step);
  }
  return steps;
}

function runScenario(rig: SoldierRig, kind: 'alive' | 'death'): Json {
  const soldier = new Soldier(rig, 'alpha');
  const internals = soldier as unknown as { skeleton: { modelQ: THREE.Quaternion[]; modelP: THREE.Vector3[]; bones: THREE.Object3D[] }; gun: THREE.Mesh; pivot: THREE.Group };
  const root = soldier.root;
  const steps = scenarioSteps(kind);
  const joints = (() => {
    const names: string[] = [];
    let mesh: THREE.SkinnedMesh | null = null;
    root.traverse((child) => {
      if ((child as THREE.SkinnedMesh).isSkinnedMesh) mesh = child as THREE.SkinnedMesh;
    });
    for (const bone of (mesh as unknown as THREE.SkinnedMesh).skeleton.bones) names.push(bone.name);
    return { names, bones: (mesh as unknown as THREE.SkinnedMesh).skeleton.bones };
  })();
  const records: Json[] = [];
  const muzzle = new THREE.Vector3();
  const rootInverse = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  steps.forEach((step, index) => {
    root.position.x += step.vx * Math.min(Math.max(step.dt, 0), 0.1);
    root.position.z += step.vz * Math.min(Math.max(step.dt, 0), 0.1);
    root.rotation.y = step.yaw;
    root.updateMatrixWorld(true);
    soldier.setState({ speed: step.speed, crouching: step.crouching, aimPitch: step.aimPitch, aiming: step.aiming, firing: step.firing, reloading: step.reloading });
    if (step.flinch) soldier.flinch(step.flinch);
    if (step.die) soldier.die(new THREE.Vector3(...step.die));
    if (step.revive) soldier.revive();
    soldier.update(step.dt);
    // Pose every frame: in Node no camera draws the soldier, so the LOD schedule would thin it out.
    (soldier as unknown as { refresh(): void }).refresh();
    if (index % 6 !== 5 && !step.die && !step.flinch && !step.revive) return;
    root.updateMatrixWorld(true);
    soldier.muzzleWorld(muzzle);
    rootInverse.copy(root.matrixWorld).invert();
    const palette: number[] = [];
    for (const bone of joints.bones) {
      local.multiplyMatrices(rootInverse, bone.matrixWorld);
      const e = local.elements;
      palette.push(e[0]!, e[1]!, e[2]!, e[4]!, e[5]!, e[6]!, e[8]!, e[9]!, e[10]!, e[12]!, e[13]!, e[14]!);
    }
    records.push({
      step: index,
      modelQ: internals.skeleton.modelQ.flatMap(q4),
      modelP: internals.skeleton.modelP.flatMap(v3),
      gun: [...v3(internals.gun.position), ...q4(internals.gun.quaternion)],
      pivotYaw: internals.pivot.rotation.y,
      muzzle: v3(muzzle),
      palette,
    });
  });
  return {
    kind,
    team: 'alpha',
    joints: joints.names,
    steps: steps.map((s) => [s.dt, s.speed, s.crouching, s.aimPitch, s.aiming, s.firing, s.reloading, s.vx, s.vz, s.yaw, s.flinch ?? null, s.die ?? null, s.revive ?? false]),
    records,
  };
}

// ---- Output ----

function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort((item as Record<string, unknown>)[key])]));
    return item;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** One case per line, so a diff names the case that changed. */
function fixtureText(value: Record<string, Json>): string {
  const lines: string[] = [];
  const keys = Object.keys(value).sort();
  keys.forEach((key, index) => {
    const item = value[key];
    const comma = index < keys.length - 1 ? ',' : '';
    if (Array.isArray(item)) {
      lines.push(`  ${JSON.stringify(key)}: [`);
      item.forEach((entry, i) => lines.push(`    ${JSON.stringify(entry)}${i < item.length - 1 ? ',' : ''}`));
      lines.push(`  ]${comma}`);
    } else if (item && typeof item === 'object') {
      lines.push(`  ${JSON.stringify(key)}: ${fixtureText(item as Record<string, Json>).trimEnd().replace(/\n/g, '\n  ')}${comma}`);
    } else {
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(item)}${comma}`);
    }
  });
  return `{\n${lines.join('\n')}\n}\n`;
}

it('exports the soldier constants and fixtures', async () => {
  const rig = await loadRig();
  const outputs: Record<string, string> = {
    'characters.json': canonical(constantsTable()),
    'fixtures/characters.json': fixtureText({
      pose: poseFixtures(rig),
      locomotion: locomotionFixtures(),
      death: deathFixtures(),
      reactions: reactionFixtures(),
      lod: lodFixtures(),
      ik: ikFixtures(),
      gunHold: gunHoldFixtures(),
      rig: rigFixtures(rig),
    }),
    'fixtures/soldier-alive.json': fixtureText(runScenario(rig, 'alive') as Record<string, Json>),
    'fixtures/soldier-death.json': fixtureText(runScenario(rig, 'death') as Record<string, Json>),
  };
  if (check) {
    const stale = Object.entries(outputs).filter(([name, text]) => {
      const path = resolve(contractDir, name);
      return !existsSync(path) || readFileSync(path, 'utf8') !== text;
    });
    expect(stale.map(([name]) => name), 'native/Contract character files are out of date; run native/Tools/asset-bake/characters-export.sh').toEqual([]);
    return;
  }
  for (const [name, text] of Object.entries(outputs)) {
    const path = resolve(contractDir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
});
