// Builds public/assets/local/characters/soldier.glb and src/characters/clip-meta.ts.
//
// Sources (downloaded to .cache/characters, git-ignored):
//   - "Ukrainian Soldier" by doctortex, CC BY 4.0 (mesh and skeleton, no clips)
//   - Quaternius Universal Animation Library, CC0 (clips on a different rig)
//
// Steps: merge the mesh's three materials into one atlas (one draw call), drop
// hidden and alpha-only triangles, rescale to metres facing -Z, retarget the
// clips onto the soldier's skeleton with rest-pose correction and a foot-lock
// pass, bake everything into one GLB with WebP textures.
//
// Also builds public/assets/local/characters/carbine.glb, the rifle soldiers carry, from the
// first-person M4A1 (public/assets/local/guns/m4a1.glb, CC BY 4.0, MrM0lten) when that file is present.
//
// Usage: node scripts/process-soldier.mjs
// Needs dev packages: @gltf-transform/core, @gltf-transform/extensions, meshoptimizer, sharp.
// Run with Node 22.18 or later: it imports src/characters/retarget.ts directly.
import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import {
  RETARGET_MAP,
  TARGET_PARENT,
  poseAxis,
  quatConjugate,
  quatFromUnitVectors,
  quatMultiply,
  quatNormalize,
  quatRotate,
  referenceRotation,
  retargetRotation,
  solveLeg,
} from '../src/characters/retarget.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(root, '.cache', 'characters');
const OUT_GLB = join(root, 'public', 'assets', 'local', 'characters', 'soldier.glb');
const OUT_META = join(root, 'src', 'characters', 'clip-meta.ts');
/** The first-person M4A1, reduced to one small mesh for soldiers to carry. */
const GUN_SOURCE = join(root, 'public', 'assets', 'local', 'guns', 'm4a1.glb');
const OUT_GUN = join(root, 'public', 'assets', 'local', 'characters', 'carbine.glb');
const OUT_GUN_META = join(root, 'src', 'characters', 'carbine-meta.ts');
const GUN_TRIANGLES = 3200;
/** Most the reduced rifle may stray from the original, as a share of its length. More than this eats the barrel. */
const GUN_ERROR = 0.008;
/** Parts of the rifle with fewer triangles than this are left out. */
const GUN_SMALL_PART = 400;
/** Atlas size; each of the rifle's materials gets a quarter of it. */
const GUN_TEXTURE = 1024;
const GUN_TILE_MARGIN = 0.01;
/** Where up the butt plate the shoulder pocket takes it (0 bottom, 1 top). */
const BUTT_CONTACT = 0.72;

const SOURCES = {
  mesh: {
    file: 'soldier-a.glb',
    url: 'https://huggingface.co/datasets/allenai/objaverse/resolve/main/glbs/000-083/94f74f6bdd994733a8a40c7ff088e12f.glb',
    sha256: '756876e9db6e80852e2ec4bec8d973be643a2222da8efaa8d9209973b21fac95',
  },
  clips: {
    file: 'ual1.glb',
    url: 'https://media.githubusercontent.com/media/series-ai/jam-ready-assets/ab1b21fe61bc3adeb759c286e770033563f18a97/quaternius-universal-animation-library/3D/characters/UAL1_Standard.glb',
    sha256: '69591853d817488edaa8fd9bf8fc1d821eaeaf789f8627b3cd23b41c4ed67997',
  },
};

/**
 * Per-clip reshaping done while baking, with the feet re-planted by leg IK:
 * - `bounce`: fraction of the hips' rise and fall to keep. The library's runs
 *   leap higher than a soldier in kit would.
 * - `stride`: scale on how far the feet travel fore and aft. The library's run
 *   covers 2.8 m a step; the walk is a stroll. These bring the natural speeds
 *   to about 1.3 (walk), 3.1 (jog) and 4.3 m/s (run) so the game's speeds
 *   play near normal rate without the feet sliding.
 * - `lift`: metres added to the hips. Sets the crouch so the head sits in the
 *   game's crouched hit volume, and lowers the walk into a crouched run (the
 *   library's own crouch walk is a slow sneak, and a run has both feet off
 *   the ground, which reads as a hop when crouched).
 * - `footLift`: scale on how high the feet come off the ground. The library's
 *   jog tucks both feet up for most of each step, which reads as hopping.
 * - `stance`: share of each step the foot spends planted. The library's jog
 *   is in the air for two thirds of every step; this re-times it.
 * - `pitch`: radians the pelvis and everything above it tips (negative is
 *   forwards), for the bent-over crouched run.
 * - `lead`: metres the hips are carried ahead of where the clip has them over
 *   the feet (negative puts them behind). A runner leans into the run with the
 *   feet landing under the body; a crouched one sits back over them.
 *
 * After any of these the hips are moved so the planted leg keeps the bend the
 * clip gave it (see `legRoom`), and a re-timed gait has its toe paths redrawn
 * (see `smoothToePath`). The library's "jog" is a bounding run at about 6 m/s
 * and its sprint nearer 9, so the jog and the run here are both that jog with
 * a shorter stride, more time on the ground and less bounce, and they play
 * faster than they were made: about three steps a second at the game's speeds.
 */
const CLIPS = [
  { source: 'Idle_Loop', name: 'idle', loop: true },
  { source: 'Walk_Loop', name: 'walk', loop: true, gait: true, stride: 1.3, bounce: 0.6 },
  { source: 'Jog_Fwd_Loop', name: 'jog', loop: true, gait: true, bounce: 0.5, stride: 0.85, footLift: 0.45, stance: 0.6, lift: 0.06, lead: 0.1 },
  { source: 'Jog_Fwd_Loop', name: 'run', loop: true, gait: true, bounce: 0.6, stride: 0.95, footLift: 0.7, stance: 0.45, lift: 0.05, lead: 0.12 },
  { source: 'Crouch_Idle_Loop', name: 'crouchIdle', loop: true, lift: -0.1 },
  { source: 'Crouch_Fwd_Loop', name: 'crouchWalk', loop: true, gait: true, lift: -0.1, stride: 1.5 },
  { source: 'Walk_Loop', name: 'crouchJog', loop: true, gait: true, stride: 1.1, lift: -0.36, pitch: -0.7, lead: -0.08, bounce: 0.6 },
  { source: 'Death01', name: 'death', loop: false },
];

const FPS = 30;
const TWEAKS = JSON.parse(process.env.CLIP_TWEAK ?? '{}');
/** Radians a bone may turn between two baked frames before the bake warns about it. */
const JUMP_WARNING = 0.9;
/** A foot this far off the ground no longer carries weight, metres. */
const PLANTED_HEIGHT = 0.1;
/** Passes of a three-frame blur over the hips correction. */
const ROOM_SMOOTHING = 3;
/** A sole within this height of the ground counts as planted, metres. */
const GROUNDED_HEIGHT = 0.015;
/** Distance from the ankle joint back to the heel's contact point, metres. */
const HEEL_BEHIND_ANKLE = 0.06;
/** The soldier's right in the output frame (it faces -Z). */
const MODEL_RIGHT = [1, 0, 0];
/** Height of the head's centre in the idle pose, to match the game's hit volumes. */
const HEAD_CENTRE_HEIGHT = 1.64;
/** Head centre relative to the head joint in the source mesh's rest pose, centimetres. */
const HEAD_CENTRE_OFFSET_CM = [0, 11.5, 1];
const ATLAS = 2048;
const TILE = ATLAS / 2;
/** Atlas tile (column, row) for each source material. */
const TILE_OF = { PackedMaterial0mat: [0, 0], PackedMaterial1mat: [1, 0], PackedMaterial2mat: [0, 1] };
/** Uniform cloth, as quadrants (column, row) of a material's own texture: recoloured per team. */
const UNIFORM_QUADS = { PackedMaterial1mat: [[0, 0], [1, 1]], PackedMaterial2mat: [[1, 1]] };
/** Meshes left out: `default` is the eyelash card, which needs alpha blending. */
const SKIP_MESHES = new Set(['default']);
const Y180 = [0, 1, 0, 0];

const log = (text) => process.stdout.write(`${text}\n`);
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a) => scale(a, 1 / (length(a) || 1));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const cleanName = (name) => name.replace(/^mixamorig:/, '').replace(/_\d+$/, '');

function slerp(a, b, t) {
  let cosine = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const sign = cosine < 0 ? -1 : 1;
  cosine *= sign;
  if (cosine > 0.9995) return quatNormalize(a.map((v, i) => v + (b[i] * sign - v) * t));
  const angle = Math.acos(cosine);
  const wa = Math.sin((1 - t) * angle) / Math.sin(angle);
  const wb = (Math.sin(t * angle) / Math.sin(angle)) * sign;
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb, a[3] * wa + b[3] * wb];
}

// ------------------------------------------------------------------ download

async function fetchSources() {
  await mkdir(CACHE, { recursive: true });
  for (const source of Object.values(SOURCES)) {
    const target = join(CACHE, source.file);
    const present = await stat(target).then((info) => info.size > 0, () => false);
    if (present) continue;
    const response = await fetch(source.url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`${source.file}: ${response.status} ${response.statusText}`);
    const data = Buffer.from(await response.arrayBuffer());
    const hash = createHash('sha256').update(data).digest('hex');
    if (source.sha256 && hash !== source.sha256) throw new Error(`${source.file}: sha256 mismatch (${hash})`);
    await writeFile(target, data);
    log(`downloaded ${source.file} (${data.length} bytes)`);
  }
}

// ------------------------------------------------------------------ skeletons

/** Flattens a joint hierarchy into arrays with world rest transforms (rotation and position only). */
function readSkeleton(rootNode, nameOf) {
  const joints = [];
  const visit = (node, parent) => {
    const index = joints.length;
    joints.push({ node, name: nameOf(node.getName()), parent, q: node.getRotation(), t: node.getTranslation() });
    for (const child of node.listChildren()) visit(child, index);
  };
  visit(rootNode, -1);
  const byName = new Map(joints.map((joint, index) => [joint.name, index]));
  return { joints, byName };
}

/** World rotation and position of every joint for the given local poses. */
function worldPose(skeleton, localQ, localT) {
  const q = [];
  const p = [];
  skeleton.joints.forEach((joint, index) => {
    const lq = localQ?.[index] ?? joint.q;
    const lt = localT?.[index] ?? joint.t;
    if (joint.parent < 0) {
      q.push(lq);
      p.push(lt);
    } else {
      q.push(quatMultiply(q[joint.parent], lq));
      p.push(add(p[joint.parent], quatRotate(q[joint.parent], lt)));
    }
  });
  return { q, p };
}

/** Samples every animated joint of a clip at `time`. */
function makeClipSampler(animation, skeleton) {
  const tracks = [];
  for (const channel of animation.listChannels()) {
    const index = skeleton.byName.get(channel.getTargetNode()?.getName() ?? '');
    const path = channel.getTargetPath();
    if (index === undefined || path === 'scale' || path === 'weights') continue;
    const sampler = channel.getSampler();
    if (sampler.getInterpolation() === 'CUBICSPLINE') throw new Error('cubic spline clips are not supported');
    tracks.push({ index, path, times: sampler.getInput().getArray(), values: sampler.getOutput().getArray(), step: sampler.getInterpolation() === 'STEP' });
  }
  const duration = Math.max(...tracks.map((track) => track.times[track.times.length - 1]));
  const sample = (time) => {
    const localQ = [];
    const localT = [];
    for (const track of tracks) {
      const { times, values } = track;
      let hi = 1;
      while (hi < times.length - 1 && times[hi] < time) hi++;
      const lo = Math.max(0, hi - 1);
      hi = Math.min(hi, times.length - 1);
      const span = times[hi] - times[lo];
      const mix = track.step || span <= 0 ? 0 : Math.min(1, Math.max(0, (time - times[lo]) / span));
      const size = track.path === 'rotation' ? 4 : 3;
      const a = Array.from(values.subarray(lo * size, lo * size + size));
      const b = Array.from(values.subarray(hi * size, hi * size + size));
      if (track.path === 'rotation') localQ[track.index] = slerp(a, b, mix);
      else localT[track.index] = lerp(a, b, mix);
    }
    return worldPose(skeleton, localQ, localT);
  };
  return { duration, sample };
}

/** Puts a world pose into the output frame: facing -Z, scaled. */
function toOutputFrame(pose, factor) {
  return {
    q: pose.q.map((q) => quatMultiply(Y180, q)),
    p: pose.p.map((p) => scale(quatRotate(Y180, p), factor)),
  };
}

// ------------------------------------------------------------------ retarget

function buildRetargeter(source, target, factor) {
  const sourceRest = toOutputFrame(worldPose(source), 1);
  const s = (name) => source.byName.get(name);
  const t = (name) => target.byName.get(name);
  const reference = new Map();
  for (const entry of RETARGET_MAP) {
    let align = [0, 0, 0, 1];
    const basis = entry.align === 'parent' ? RETARGET_MAP.find((other) => other.target === TARGET_PARENT[entry.target]) : entry;
    if (basis.align === 'direction') {
      const sourceDir = normalize(sub(sourceRest.p[s(basis.sourceChild)], sourceRest.p[s(basis.source)]));
      const targetDir = normalize(sub(target.rest.p[t(basis.targetChild)], target.rest.p[t(basis.target)]));
      align = quatFromUnitVectors(sourceDir, targetDir);
    }
    reference.set(entry.target, referenceRotation(sourceRest.q[s(entry.source)], align));
  }

  const legLength = (pose, hip, knee, ankle) => length(sub(pose.p[knee], pose.p[hip])) + length(sub(pose.p[ankle], pose.p[knee]));
  const sourceLeg = legLength(sourceRest, s('thigh_l'), s('calf_l'), s('foot_l')) + sourceRest.p[s('foot_l')][1];
  const targetLeg = legLength(target.rest, t('LeftUpLeg'), t('LeftLeg'), t('LeftFoot')) + target.rest.p[t('LeftFoot')][1];
  const ratio = targetLeg / sourceLeg;
  const hipsRest = t('Hips');
  const hipMid = scale(add(target.rest.p[t('LeftUpLeg')], target.rest.p[t('RightUpLeg')]), 0.5);
  const hipMidLocal = quatRotate(quatConjugate(target.rest.q[hipsRest]), sub(hipMid, target.rest.p[hipsRest]));
  const sides = ['Left', 'Right'].map((Side) => {
    const side = Side === 'Left' ? 'l' : 'r';
    const up = t(`${Side}UpLeg`);
    const knee = t(`${Side}Leg`);
    const foot = t(`${Side}Foot`);
    return {
      Side,
      sourceHip: s(`thigh_${side}`),
      sourceFoot: s(`foot_${side}`),
      upLocal: quatRotate(quatConjugate(target.rest.q[hipsRest]), sub(target.rest.p[up], target.rest.p[hipsRest])),
      upper: length(sub(target.rest.p[knee], target.rest.p[up])),
      lower: length(sub(target.rest.p[foot], target.rest.p[knee])),
      upDir: normalize(sub(target.rest.p[knee], target.rest.p[up])),
      lowDir: normalize(sub(target.rest.p[foot], target.rest.p[knee])),
      upRest: target.rest.q[up],
      lowRest: target.rest.q[knee],
      sourceBall: s(`ball_${side}`),
      sourceBallRest: sourceRest.p[s(`ball_${side}`)][1],
      targetToeRest: target.rest.p[t(`${Side}ToeBase`)][1],
      toeLocal: quatRotate(quatConjugate(target.rest.q[foot]), sub(target.rest.p[t(`${Side}ToeBase`)], target.rest.p[foot])),
      // The back of the heel: level with the ball of the foot, a little behind the ankle.
      heelLocal: quatRotate(quatConjugate(target.rest.q[foot]), [0, target.rest.p[t(`${Side}ToeBase`)][1] - target.rest.p[foot][1], HEEL_BEHIND_ANKLE]),
    };
  });

  /**
   * World rotations and hips position of the target for one source pose.
   * `hipsY`, when given, replaces the height the source puts the hips at.
   */
  return (rawPose, { hipsY, stride = 1, pitch = 0, footLift = 1, lead = 0, toeZ } = {}) => {
    const pose = toOutputFrame(rawPose, 1);
    const world = new Map();
    for (const entry of RETARGET_MAP) {
      world.set(entry.target, retargetRotation(pose.q[s(entry.source)], reference.get(entry.target), target.rest.q[t(entry.target)]));
    }
    if (pitch !== 0) {
      // Tip the pelvis and upper body; the legs keep their own rotations and are re-planted below.
      const tip = [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)];
      for (const entry of RETARGET_MAP) {
        if (!/UpLeg|Leg$|Foot|ToeBase/.test(entry.target)) world.set(entry.target, quatNormalize(quatMultiply(tip, world.get(entry.target))));
      }
    }
    const sourceMid = scale(add(pose.p[s('thigh_l')], pose.p[s('thigh_r')]), 0.5);
    const hipsQ = world.get('Hips');
    const hips = sub(scale(sourceMid, ratio), quatRotate(hipsQ, hipMidLocal));
    const rawHipsY = hips[1];
    if (hipsY !== undefined) hips[1] = hipsY;
    // The stride is scaled about where the clip has the hips; `lead` then carries the body ahead of the feet.
    const strideOrigin = hips[2];
    hips[2] -= lead;

    // The pelvis's side-to-side axis as posed: its turn from the rest pose, applied to the model's right.
    const pelvisRight = poseAxis(hipsQ, target.rest.q[hipsRest], MODEL_RIGHT);
    // Foot lock: put the ball of each foot where the source's is (scaled), so stance feet stay planted.
    const ankles = {};
    const toes = {};
    const legs = {};
    for (const leg of sides) {
      const hip = add(hips, quatRotate(hipsQ, leg.upLocal));
      const upQ = world.get(`${leg.Side}UpLeg`);
      const knee = add(hip, scale(quatRotate(quatMultiply(upQ, quatConjugate(leg.upRest)), leg.upDir), leg.upper));
      const sourceBall = pose.p[leg.sourceBall];
      const toeGoal = [sourceBall[0] * ratio, leg.targetToeRest + (sourceBall[1] - leg.sourceBallRest) * ratio * footLift, strideOrigin + (sourceBall[2] * ratio - strideOrigin) * stride];
      if (toeZ) toeGoal[2] = toeZ[leg.Side];
      const toeOffset = quatRotate(world.get(`${leg.Side}Foot`), leg.toeLocal);
      const goal = sub(toeGoal, toeOffset);
      // Where the ankle would be with the clip's own stride and foot height, for `legRoom`.
      const sourceGoal = sub([toeGoal[0], leg.targetToeRest + (sourceBall[1] - leg.sourceBallRest) * ratio, sourceBall[2] * ratio], toeOffset);
      const sourceSpan = length(sub(sourceGoal, [hip[0], hip[1], hip[2] + lead]));
      // How far the lowest part of the sole is off the ground: the heel lands first and the ball leaves last.
      const heelHeight = goal[1] + quatRotate(world.get(`${leg.Side}Foot`), leg.heelLocal)[1];
      legs[leg.Side] = { hip, goal, sourceSpan, reach: leg.upper + leg.lower, clearance: Math.min(toeGoal[1], heelHeight) - leg.targetToeRest };
      const solved = solveLeg(hip, knee, goal, leg.upper, leg.lower, pelvisRight);
      const upNow = quatRotate(quatMultiply(upQ, quatConjugate(leg.upRest)), leg.upDir);
      const lowQ = world.get(`${leg.Side}Leg`);
      const lowNow = quatRotate(quatMultiply(lowQ, quatConjugate(leg.lowRest)), leg.lowDir);
      world.set(`${leg.Side}UpLeg`, quatNormalize(quatMultiply(quatFromUnitVectors(upNow, normalize(sub(solved.knee, hip))), upQ)));
      world.set(`${leg.Side}Leg`, quatNormalize(quatMultiply(quatFromUnitVectors(lowNow, normalize(sub(solved.end, solved.knee))), lowQ)));
      ankles[leg.Side] = solved.end;
      toes[leg.Side] = add(solved.end, toeOffset);
      legs[leg.Side].knee = solved.knee;

    }

    const local = new Map();
    for (const entry of RETARGET_MAP) {
      const parent = TARGET_PARENT[entry.target];
      const parentQ = parent ? world.get(parent) : [0, 0, 0, 1];
      local.set(entry.target, quatNormalize(quatMultiply(quatConjugate(parentQ), world.get(entry.target))));
    }
    return { local, world, hips, rawHipsY, ankles, toes, legs };
  };
}

/**
 * How far to move the hips on each frame so the leg carrying the weight keeps
 * at least the extension the clip gave it after the stride or foot height was
 * changed, and can still reach a foot that was moved further away.
 * Without this a shortened stride leaves the hips where a long one put them
 * and the knees fold to take up the slack, which reads as running in a squat.
 * The feet in the air say nothing about the hips, so those frames take their
 * value from the planted frames either side, and the result is smoothed
 * around the loop.
 */
function legRoom(frames, loop) {
  const count = frames.length;
  // The most the hips may rise on each frame before a firmly planted foot is out of reach.
  const ceiling = frames.map(() => Infinity);
  const raw = frames.map((frame, index) => {
    let total = 0;
    let weight = 0;
    for (const leg of Object.values(frame.legs)) {
      const planted = Math.min(1, Math.max(0, 1 - leg.clearance / PLANTED_HEIGHT));
      if (planted <= 0) continue;
      const across = Math.hypot(leg.goal[0] - leg.hip[0], leg.goal[2] - leg.hip[2]);
      const riseFor = (span) => leg.goal[1] + Math.sqrt(Math.max(0, span * span - across * across)) - leg.hip[1];
      const limit = leg.reach * 0.995;
      // Up, so a foot brought closer does not fold the knee further; down only as far as a foot moved away needs to be reached.
      const rise = Math.max(0, riseFor(Math.min(leg.sourceSpan, limit))) + Math.min(0, riseFor(limit));
      total += rise * planted;
      weight += planted;
      if (planted > 0.8) ceiling[index] = Math.min(ceiling[index], riseFor(limit));
    }
    return weight > 0.05 ? total / weight : null;
  });
  if (raw.every((value) => value === null)) return { room: raw.map(() => 0), ceiling };
  const at = (index) => (loop ? ((index % count) + count) % count : Math.min(count - 1, Math.max(0, index)));
  const filled = raw.map((value, index) => {
    if (value !== null) return value;
    let before = 1;
    let after = 1;
    while (before < count && raw[at(index - before)] === null) before++;
    while (after < count && raw[at(index + after)] === null) after++;
    const a = raw[at(index - before)] ?? raw[at(index + after)];
    const b = raw[at(index + after)] ?? a;
    return a + ((b - a) * before) / (before + after);
  });
  let smooth = filled;
  for (let pass = 0; pass < ROOM_SMOOTHING; pass++) smooth = smooth.map((value, index) => (smooth[at(index - 1)] + 2 * value + smooth[at(index + 1)]) / 4);
  return { room: smooth, ceiling };
}

/**
 * Maps an output frame to a source frame so that each foot's time on the
 * ground fills `fraction` of a step. Both steps of the cycle are treated alike.
 */
function stanceWarp(frames, fraction) {
  const count = frames.length;
  const half = count / 2;
  const grounded = frames.map((frame) => frame.legs.Left.clearance < GROUNDED_HEIGHT);
  const start = grounded.findIndex((on, index) => on && !grounded[(index + count - 1) % count]);
  let planted = 0;
  while (planted < count && grounded[(start + planted) % count]) planted++;
  const target = fraction * half;
  return (index) => {
    const offset = (((index - start) % count) + count) % count;
    const step = Math.floor(offset / half);
    const within = offset - step * half;
    const source = within < target ? within * (planted / target) : planted + (within - target) * ((half - planted) / (half - target));
    return start + step * half + source + count;
  };
}

/**
 * Fore-and-aft path of each toe for a re-timed gait. Re-timing plays the
 * planted part of the step slower and the swing faster, which leaves the foot
 * whipping back at several times ground speed just before it lands. This
 * redraws the path: a planted toe travels back at one steady speed, and the
 * swing is a smooth curve that leaves the ground and meets it again at that
 * same speed. Heights and foot angles stay as the clip has them.
 */
function smoothToePath(frames) {
  const count = frames.length;
  const path = frames.map(() => ({}));
  for (const Side of ['Left', 'Right']) {
    const grounded = frames.map((frame) => frame.legs[Side].clearance < GROUNDED_HEIGHT);
    const land = grounded.findIndex((on, index) => on && !grounded[(index + count - 1) % count]);
    if (land < 0) throw new Error('gait has no planted frames to re-time');
    let planted = 1;
    while (planted < count && grounded[(land + planted) % count]) planted++;
    const last = planted - 1;
    const front = frames[land].toes[Side][2];
    const back = frames[(land + last) % count].toes[Side][2];
    const speed = (back - front) / last;
    const swing = count - last;
    for (let offset = 0; offset < count; offset++) {
      let z = front + speed * offset;
      if (offset > last) {
        const u = (offset - last) / swing;
        const u2 = u * u;
        const u3 = u2 * u;
        z = (2 * u3 - 3 * u2 + 1) * back + (u3 - 2 * u2 + u) * swing * speed + (-2 * u3 + 3 * u2) * front + (u3 - u2) * swing * speed;
      }
      path[(land + offset) % count][Side] = z;
    }
  }
  return path;
}

/** Ground speed a looping gait covers, from how fast planted feet travel backwards, and where the left foot lands. */
function gaitMeta(frames, duration) {
  // The median, because a foot rolling onto or off the ground moves at other speeds for a frame or two.
  const speeds = [];
  for (const Side of ['Left', 'Right']) {
    frames.forEach((frame, index) => {
      const next = frames[(index + 1) % frames.length];
      if (frame.legs[Side].clearance > GROUNDED_HEIGHT || next.legs[Side].clearance > GROUNDED_HEIGHT) return;
      speeds.push((next.toes[Side][2] - frame.toes[Side][2]) * FPS);
    });
  }
  speeds.sort((a, b) => a - b);
  const speed = speeds.length ? speeds[Math.floor(speeds.length / 2)] : 0;
  let strike = 0;
  frames.forEach((frame, index) => {
    if (frame.toes.Left[2] < frames[strike].toes.Left[2]) strike = index;
  });
  return { speed, strike: strike / frames.length, duration };
}


// ------------------------------------------------------------------ authored forward fall

const RAD = Math.PI / 180;
const rotX = (deg) => [Math.sin((deg * RAD) / 2), 0, 0, Math.cos((deg * RAD) / 2)];
const rotY = (deg) => [0, Math.sin((deg * RAD) / 2), 0, Math.cos((deg * RAD) / 2)];
const rotZ = (deg) => [0, 0, Math.sin((deg * RAD) / 2), Math.cos((deg * RAD) / 2)];
const compose = (...quats) => quats.reduce((a, b) => quatMultiply(a, b));

/**
 * Key poses for a collapse onto the face, for a soldier shot from behind (the
 * library only has a fall onto the back). Angles in degrees, lengths in metres.
 *  time; hips height and forward travel; torso pitch forwards, roll and yaw;
 *  head: extra nod and turn; ankle height and how far behind the start it sits;
 *  foot pitch (negative rolls onto the toes, -180 is sole up);
 *  arms [right, left] as [drop from the T-pose, swing forward, elbow fold forward, elbow fold toward the head].
 */
const FORWARD_FALL = [
  { t: 0.0, hipsY: 0.95, hipsZ: 0.0, torso: 6, roll: 0, yaw: 0, nod: 0, turn: 0, ankleY: 0.1, ankleZ: 0.0, foot: 0, arms: [[62, 28, 70, 0], [62, 30, 60, 0]] },
  { t: 0.14, hipsY: 0.91, hipsZ: -0.07, torso: -6, roll: 2, yaw: 3, nod: -22, turn: 4, ankleY: 0.1, ankleZ: 0.0, foot: 0, arms: [[50, 14, 60, 0], [48, 18, 50, 0]] },
  { t: 0.36, hipsY: 0.74, hipsZ: -0.2, torso: 26, roll: 4, yaw: 6, nod: 24, turn: 8, ankleY: 0.13, ankleZ: 0.02, foot: -22, arms: [[58, 26, 40, 0], [64, 16, 30, 0]] },
  { t: 0.6, hipsY: 0.5, hipsZ: -0.36, torso: 52, roll: 6, yaw: 9, nod: 30, turn: 14, ankleY: 0.18, ankleZ: 0.08, foot: -72, arms: [[40, 46, 46, 0], [66, 22, 26, 0]] },
  { t: 0.84, hipsY: 0.25, hipsZ: -0.62, torso: 80, roll: 7, yaw: 10, nod: 6, turn: 30, ankleY: 0.1, ankleZ: 0.1, foot: -150, arms: [[10, 28, 20, 50], [62, 18, 12, 8]] },
  { t: 0.98, hipsY: 0.15, hipsZ: -0.74, torso: 93, roll: 5, yaw: 10, nod: -8, turn: 52, ankleY: 0.07, ankleZ: 0.16, foot: -164, arms: [[-24, 24, 4, 72], [60, 15, 4, 14]] },
  { t: 1.08, hipsY: 0.168, hipsZ: -0.75, torso: 90, roll: 5, yaw: 10, nod: -4, turn: 55, ankleY: 0.075, ankleZ: 0.16, foot: -160, arms: [[-26, 20, 4, 70], [60, 12, 4, 14]] },
  { t: 1.24, hipsY: 0.15, hipsZ: -0.755, torso: 93, roll: 5, yaw: 10, nod: -8, turn: 56, ankleY: 0.07, ankleZ: 0.16, foot: -164, arms: [[-27, 24, 4, 72], [60, 15, 4, 14]] },
];

/** Catmull-Rom through the keys, so the body accelerates through them instead of pausing at each. */
function fallPoseAt(time) {
  const keys = FORWARD_FALL;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t < time) i++;
  const k = [keys[Math.max(0, i - 1)], keys[i], keys[i + 1], keys[Math.min(keys.length - 1, i + 2)]];
  const u = Math.min(1, Math.max(0, (time - k[1].t) / (k[2].t - k[1].t)));
  const spline = (a, b, c, d) => {
    // Tangents scaled by the uneven key spacing, clamped so a channel never overshoots between two keys.
    const m1 = ((c - a) / (k[2].t - k[0].t || 1)) * (k[2].t - k[1].t);
    const m2 = ((d - b) / (k[3].t - k[1].t || 1)) * (k[2].t - k[1].t);
    const u2 = u * u;
    const u3 = u2 * u;
    const value = (2 * u3 - 3 * u2 + 1) * b + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * c + (u3 - u2) * m2;
    return Math.min(Math.max(value, Math.min(b, c) - Math.abs(c - b) * 0.15), Math.max(b, c) + Math.abs(c - b) * 0.15);
  };
  const out = {};
  for (const name of Object.keys(k[1])) {
    if (name === 't') continue;
    out[name] = name === 'arms' ? k[1].arms.map((arm, side) => arm.map((_, n) => spline(k[0].arms[side][n], k[1].arms[side][n], k[2].arms[side][n], k[3].arms[side][n]))) : spline(k[0][name], k[1][name], k[2][name], k[3][name]);
  }
  return out;
}

/** Builds the forward fall as frames in the same form the retargeter produces. */
function authorForwardFall(target) {
  const t = (name) => target.byName.get(name);
  const rest = (name) => target.rest.q[t(name)];
  const restP = (name) => target.rest.p[t(name)];
  const last = FORWARD_FALL[FORWARD_FALL.length - 1].t;
  const count = Math.round(last * FPS) + 1;
  const frames = [];
  for (let index = 0; index < count; index++) {
    const key = fallPoseAt(index / FPS);
    const world = new Map();
    const lean = (share) => compose(rotY(key.yaw), rotZ(key.roll), rotX(-key.torso * share));
    // The spine curls a little further forward toward the chest.
    const body = { Hips: lean(0.98), Spine: lean(1.0), Spine1: lean(1.02), Spine2: lean(1.04) };
    for (const [name, q] of Object.entries(body)) world.set(name, quatNormalize(quatMultiply(q, rest(name))));
    const chest = body.Spine2;
    world.set('Neck', quatNormalize(compose(chest, rotY(key.turn * 0.4), rotX(-key.nod * 0.4), rest('Neck'))));
    world.set('Head', quatNormalize(compose(chest, rotY(key.turn), rotX(-key.nod), rest('Head'))));
    ['Right', 'Left'].forEach((Side, n) => {
      const sign = Side === 'Right' ? 1 : -1;
      const [drop, swing, foldForward, foldUp] = key.arms[n];
      const upper = compose(chest, rotZ(-sign * drop), rotY(sign * swing));
      const lower = compose(upper, rotY(sign * foldForward), rotZ(sign * foldUp));
      world.set(`${Side}Shoulder`, quatNormalize(quatMultiply(chest, rest(`${Side}Shoulder`))));
      world.set(`${Side}Arm`, quatNormalize(quatMultiply(upper, rest(`${Side}Arm`))));
      world.set(`${Side}ForeArm`, quatNormalize(quatMultiply(lower, rest(`${Side}ForeArm`))));
      world.set(`${Side}Hand`, quatNormalize(compose(lower, rotX(18), rest(`${Side}Hand`))));
    });

    // Legs by IK from the pelvis to feet that stay where they stood; raise the pelvis if a knee would sink.
    const hips = [0, key.hipsY, key.hipsZ];
    const ankles = {};
    const toes = {};
    for (let attempt = 0; attempt < 30; attempt++) {
      let lowestKnee = Infinity;
      for (const Side of ['Left', 'Right']) {
        const sign = Side === 'Right' ? 1 : -1;
        const up = `${Side}UpLeg`;
        const hipLocal = quatRotate(quatConjugate(rest('Hips')), sub(restP(up), restP('Hips')));
        const hip = add(hips, quatRotate(world.get('Hips'), hipLocal));
        const upper = length(sub(restP(`${Side}Leg`), restP(up)));
        const lower = length(sub(restP(`${Side}Foot`), restP(`${Side}Leg`)));
        // The right leg trails a little so the two do not land as a mirror image.
        const goal = [restP(`${Side}Foot`)[0] * 1.15, key.ankleY, restP(`${Side}Foot`)[2] + key.ankleZ + (sign > 0 ? 0.07 : 0) * Math.min(1, key.torso / 60)];
        const hint = add(hip, [sign * 0.12, -0.25, -1]);
        const solved = solveLeg(hip, hint, goal, upper, lower, MODEL_RIGHT);
        lowestKnee = Math.min(lowestKnee, solved.knee[1]);
        const upDir = normalize(sub(restP(`${Side}Leg`), restP(up)));
        const lowDir = normalize(sub(restP(`${Side}Foot`), restP(`${Side}Leg`)));
        world.set(up, quatNormalize(quatMultiply(quatFromUnitVectors(upDir, normalize(sub(solved.knee, hip))), rest(up))));
        world.set(`${Side}Leg`, quatNormalize(quatMultiply(quatFromUnitVectors(lowDir, normalize(sub(solved.end, solved.knee))), rest(`${Side}Leg`))));
        const foot = compose(rotY(-sign * 14 * Math.min(1, key.torso / 60)), rotX(key.foot));
        world.set(`${Side}Foot`, quatNormalize(quatMultiply(foot, rest(`${Side}Foot`))));
        world.set(`${Side}ToeBase`, quatNormalize(quatMultiply(foot, rest(`${Side}ToeBase`))));
        ankles[Side] = solved.end;
        toes[Side] = solved.end;
      }
      if (lowestKnee >= 0.06) break;
      hips[1] += 0.01;
    }

    const local = new Map();
    for (const entry of RETARGET_MAP) {
      const parent = TARGET_PARENT[entry.target];
      local.set(entry.target, quatNormalize(quatMultiply(quatConjugate(parent ? world.get(parent) : [0, 0, 0, 1]), world.get(entry.target))));
    }
    frames.push({ local, world, hips, rawHipsY: hips[1], ankles, toes });
  }
  return { name: 'deathFront', loop: false, frames, duration: (count - 1) / FPS };
}

// ------------------------------------------------------------------ mesh and textures

async function rawImage(texture, size, channels) {
  let image = sharp(Buffer.from(texture.getImage())).resize(size, size);
  image = channels === 4 ? image.ensureAlpha() : channels === 1 ? image.greyscale() : image.removeAlpha();
  return image.raw().toBuffer();
}

async function buildAtlases(materials) {
  const colour = [];
  const normal = [];
  const half = TILE / 2;
  const orm = Buffer.alloc(TILE * TILE * 3);
  const alpha = new Map();
  for (const material of materials) {
    const [column, row] = TILE_OF[material.getName()];
    const specGloss = material.getExtension('KHR_materials_pbrSpecularGlossiness');
    const diffuse = await rawImage(specGloss.getDiffuseTexture(), TILE, 4);
    alpha.set(material.getName(), diffuse);
    colour.push({ input: await sharp(diffuse, { raw: { width: TILE, height: TILE, channels: 4 } }).removeAlpha().png().toBuffer(), left: column * TILE, top: row * TILE });
    normal.push({ input: await sharp(Buffer.from(material.getNormalTexture().getImage())).resize(TILE, TILE).removeAlpha().png().toBuffer(), left: column * TILE, top: row * TILE });
    // Packed map at half size: R = uniform mask for the team tint, G = roughness, B = metalness (none).
    const specular = await rawImage(specGloss.getSpecularGlossinessTexture(), half, 1);
    const quads = UNIFORM_QUADS[material.getName()] ?? [];
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        const quad = [x < half / 2 ? 0 : 1, y < half / 2 ? 0 : 1];
        const uniform = quads.some((q) => q[0] === quad[0] && q[1] === quad[1]);
        const at = ((row * half + y) * TILE + column * half + x) * 3;
        orm[at] = uniform ? 255 : 0;
        orm[at + 1] = Math.round(Math.max(110, 225 - specular[y * half + x] * 0.45));
        orm[at + 2] = 0;
      }
    }
  }
  const blank = (rgb) => sharp({ create: { width: ATLAS, height: ATLAS, channels: 3, background: rgb } });
  return {
    alpha,
    colour: await blank({ r: 60, g: 60, b: 56 }).composite(colour).webp({ quality: 84, effort: 6 }).toBuffer(),
    normal: await blank({ r: 128, g: 128, b: 255 }).composite(normal).webp({ quality: 88, effort: 6 }).toBuffer(),
    orm: await sharp(orm, { raw: { width: TILE, height: TILE, channels: 3 } }).webp({ quality: 80, effort: 6 }).toBuffer(),
  };
}

/** Merges every skinned primitive into one vertex buffer in the output frame with atlas UVs. */
function mergeMeshes(meshNodes, alpha, factor) {
  const out = { position: [], normal: [], uv: [], joints: [], weights: [], index: [] };
  let dropped = 0;
  for (const node of meshNodes) {
    for (const primitive of node.getMesh().listPrimitives()) {
      const material = primitive.getMaterial().getName();
      const [column, row] = TILE_OF[material];
      const mask = alpha.get(material);
      const position = primitive.getAttribute('POSITION');
      const normal = primitive.getAttribute('NORMAL');
      const uv = primitive.getAttribute('TEXCOORD_0');
      const joints = primitive.getAttribute('JOINTS_0');
      const weights = primitive.getAttribute('WEIGHTS_0');
      const base = out.position.length / 3;
      const opaque = [];
      for (let i = 0; i < position.getCount(); i++) {
        const p = position.getElement(i, []);
        const n = normal.getElement(i, []);
        const st = uv.getElement(i, []);
        out.position.push(-p[0] * factor, p[1] * factor, -p[2] * factor);
        out.normal.push(-n[0], n[1], -n[2]);
        out.uv.push((st[0] + column) / 2, (st[1] + row) / 2);
        out.joints.push(...joints.getElement(i, []));
        const w = weights.getElement(i, []);
        const sum = w[0] + w[1] + w[2] + w[3] || 1;
        out.weights.push(...w.map((value) => value / sum));
        const px = Math.min(TILE - 1, Math.max(0, Math.floor(st[0] * TILE)));
        const py = Math.min(TILE - 1, Math.max(0, Math.floor(st[1] * TILE)));
        opaque.push(mask[(py * TILE + px) * 4 + 3] > 96);
      }
      const indices = primitive.getIndices().getArray();
      for (let i = 0; i < indices.length; i += 3) {
        const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
        // The source hides skin under clothing with zero alpha; those triangles are never seen.
        if (!opaque[a] && !opaque[b] && !opaque[c]) {
          dropped++;
          continue;
        }
        out.index.push(base + a, base + b, base + c);
      }
    }
  }
  return { ...out, dropped };
}

// ------------------------------------------------------------------ carried gun

/** Joins the first-person gun's parts into one mesh, simplifies it and shrinks its textures. */
/** Mean of the points within `depth` of one end of the gun along its length. */
function endOfGun(position, z, depth) {
  const sum = [0, 0, 0];
  let count = 0;
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < position.length; i += 3) {
    if (Math.abs(position[i + 2] - z) > depth) continue;
    sum[0] += position[i];
    sum[1] += position[i + 1];
    count++;
    low = Math.min(low, position[i + 1]);
    high = Math.max(high, position[i + 1]);
  }
  return { x: sum[0] / count, y: sum[1] / count, low, high };
}

async function buildCarbine(io) {
  const present = await stat(GUN_SOURCE).then(() => true, () => false);
  if (!present) {
    log(`no ${GUN_SOURCE}; leaving the committed carbine.glb as it is`);
    return;
  }
  const sourceDoc = await io.read(GUN_SOURCE);
  const position = [];
  const normal = [];
  const uv = [];
  const index = [];
  // Each source material gets a quarter of one atlas, so the rifle stays a single draw call.
  const tiles = new Map();
  for (const node of sourceDoc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const triangles = mesh.listPrimitives().reduce((sum, primitive) => sum + primitive.getIndices().getCount() / 3, 0);
    // The bolt, charging handle and trigger are too small to see on a soldier.
    if (triangles < GUN_SMALL_PART) continue;
    const matrix = node.getWorldMatrix();
    for (const primitive of mesh.listPrimitives()) {
      const material = primitive.getMaterial();
      if (!tiles.has(material)) tiles.set(material, tiles.size);
      if (tiles.size > 4) throw new Error('the rifle has more than four materials; the carbine atlas holds four');
      const tile = tiles.get(material);
      const base = position.length / 3;
      const positions = primitive.getAttribute('POSITION');
      const normals = primitive.getAttribute('NORMAL');
      const uvs = primitive.getAttribute('TEXCOORD_0');
      for (let i = 0; i < positions.getCount(); i++) {
        const p = positions.getElement(i, []);
        const n = normals.getElement(i, []);
        const t = uvs.getElement(i, []);
        position.push(
          matrix[0] * p[0] + matrix[4] * p[1] + matrix[8] * p[2] + matrix[12],
          matrix[1] * p[0] + matrix[5] * p[1] + matrix[9] * p[2] + matrix[13],
          matrix[2] * p[0] + matrix[6] * p[1] + matrix[10] * p[2] + matrix[14],
        );
        normal.push(...normalize([matrix[0] * n[0] + matrix[4] * n[1] + matrix[8] * n[2], matrix[1] * n[0] + matrix[5] * n[1] + matrix[9] * n[2], matrix[2] * n[0] + matrix[6] * n[1] + matrix[10] * n[2]]));
        // Keep a margin inside the tile so neighbouring tiles do not bleed in at a distance.
        const inside = (value) => GUN_TILE_MARGIN + Math.min(1, Math.max(0, value)) * (1 - 2 * GUN_TILE_MARGIN);
        uv.push(((tile % 2) + inside(t[0])) / 2, (Math.floor(tile / 2) + inside(t[1])) / 2);
      }
      for (const value of primitive.getIndices().getArray()) index.push(base + value);
    }
  }
  await MeshoptSimplifier.ready;
  const positions = new Float32Array(position);
  const [simplified, error] = MeshoptSimplifier.simplify(new Uint32Array(index), positions, 3, GUN_TRIANGLES * 3, GUN_ERROR, ['Prune', 'Permissive']);
  // Drop vertices the simplified index no longer uses.
  const remap = new Map();
  const packed = { position: [], normal: [], uv: [], index: [] };
  for (const value of simplified) {
    if (!remap.has(value)) {
      remap.set(value, remap.size);
      packed.position.push(position[value * 3], position[value * 3 + 1], position[value * 3 + 2]);
      packed.normal.push(normal[value * 3], normal[value * 3 + 1], normal[value * 3 + 2]);
      packed.uv.push(uv[value * 2], uv[value * 2 + 1]);
    }
    packed.index.push(remap.get(value));
  }

  // Atlases: colour, normal, and occlusion/roughness/metalness with each material's factors folded in.
  const half = GUN_TEXTURE / 2;
  const layers = { colour: [], normal: [], orm: [] };
  for (const [material, tile] of tiles) {
    const place = { left: (tile % 2) * half, top: Math.floor(tile / 2) * half };
    const tileOf = async (texture, channels) => sharp(await rawImage(texture, half, channels), { raw: { width: half, height: half, channels } });
    layers.colour.push({ input: await (await tileOf(material.getBaseColorTexture(), 3)).png().toBuffer(), ...place });
    layers.normal.push({ input: await (await tileOf(material.getNormalTexture(), 3)).png().toBuffer(), ...place });
    const orm = await rawImage(material.getMetallicRoughnessTexture(), half, 3);
    for (let i = 0; i < orm.length; i += 3) {
      orm[i + 1] = Math.round(orm[i + 1] * material.getRoughnessFactor());
      orm[i + 2] = Math.round(orm[i + 2] * material.getMetallicFactor());
    }
    layers.orm.push({ input: await sharp(orm, { raw: { width: half, height: half, channels: 3 } }).png().toBuffer(), ...place });
  }
  const atlas = (tilesOf, background) =>
    sharp({ create: { width: GUN_TEXTURE, height: GUN_TEXTURE, channels: 3, background } }).composite(tilesOf).webp({ quality: 82, effort: 6 }).toBuffer();

  const doc = new Document();
  doc.createBuffer();
  doc.createExtension(EXTTextureWebP).setRequired(true);
  const texture = (name, image) => doc.createTexture(name).setMimeType('image/webp').setImage(image);
  const material = doc
    .createMaterial('carbine')
    .setBaseColorTexture(texture('carbine_colour', await atlas(layers.colour, '#202020')))
    .setNormalTexture(texture('carbine_normal', await atlas(layers.normal, '#8080ff')))
    .setMetallicRoughnessTexture(texture('carbine_orm', await atlas(layers.orm, '#ff8000')))
    .setRoughnessFactor(1)
    .setMetallicFactor(1);
  const accessor = (name, type, array) => doc.createAccessor(name).setType(type).setArray(array);
  const primitive = doc
    .createPrimitive()
    .setMaterial(material)
    .setIndices(accessor('indices', 'SCALAR', new Uint16Array(packed.index)))
    .setAttribute('POSITION', accessor('position', 'VEC3', new Float32Array(packed.position)))
    .setAttribute('NORMAL', accessor('normal', 'VEC3', new Float32Array(packed.normal)))
    .setAttribute('TEXCOORD_0', accessor('uv', 'VEC2', new Float32Array(packed.uv)));
  doc.createScene('carbine').addChild(doc.createNode('Carbine').setMesh(doc.createMesh('carbine').addPrimitive(primitive)));
  const glb = await new NodeIO().registerExtensions([EXTTextureWebP]).writeBinary(doc);
  await writeFile(OUT_GUN, glb);

  // Where the barrel ends and where the stock meets the shoulder, measured so the hold follows the gun model.
  let front = Infinity;
  let back = -Infinity;
  for (let i = 2; i < position.length; i += 3) {
    front = Math.min(front, position[i]);
    back = Math.max(back, position[i]);
  }
  const muzzle = endOfGun(position, front, 0.004);
  const plate = endOfGun(position, back, 0.004);
  const round = (value) => +value.toFixed(4);
  const points = {
    muzzle: [round(muzzle.x), round(muzzle.y), round(front)],
    butt: [round(plate.x), round(plate.low + (plate.high - plate.low) * BUTT_CONTACT), round(back)],
  };
  await writeFile(
    OUT_GUN_META,
    `// Generated by scripts/process-soldier.mjs from the first-person M4A1. Do not edit by hand.

/** Points on carbine.glb in its own space (barrel along -Z, origin at the pistol grip), metres. */
export const CARBINE_POINTS = ${JSON.stringify(points, null, 2)} as const;
`,
  );
  log(`${OUT_GUN}: ${(glb.length / 1024).toFixed(0)} KB, ${packed.index.length / 3} triangles (from ${index.length / 3}, error ${(error * 1000).toFixed(1)} per mille), ${tiles.size} materials, muzzle ${points.muzzle}, butt ${points.butt}`);
}

// ------------------------------------------------------------------ main

async function main() {
  await fetchSources();
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const meshDoc = await io.read(join(CACHE, SOURCES.mesh.file));
  const clipDoc = await io.read(join(CACHE, SOURCES.clips.file));

  const skin = meshDoc.getRoot().listSkins()[0];
  const skinJoints = skin.listJoints();
  const targetRaw = readSkeleton(skin.getSkeleton(), cleanName);
  if (targetRaw.joints.some((joint, index) => joint.node !== skinJoints[index])) throw new Error('joint order differs from the skin');
  const sourceRootNode = clipDoc.getRoot().listNodes().find((node) => node.getName() === 'root');
  const source = readSkeleton(sourceRootNode, (name) => name);

  const bake = (factor) => {
    const rest = toOutputFrame(worldPose(targetRaw), factor);
    // The root joint stays unrotated; its bind matrix absorbs the half turn.
    rest.q[0] = [0, 0, 0, 1];
    const target = { ...targetRaw, rest };
    const retarget = buildRetargeter(source, target, factor);
    const clips = CLIPS.map((base) => {
      // CLIP_TWEAK='{"jog":{"stride":1}}' tries other values without editing the table.
      const clip = { ...base, ...TWEAKS[base.name] };
      const animation = clipDoc.getRoot().listAnimations().find((item) => item.getName() === clip.source);
      if (!animation) throw new Error(`clip ${clip.source} is missing`);
      const sampler = makeClipSampler(animation, source);
      const count = Math.round(sampler.duration * FPS) + (clip.loop ? 0 : 1);
      let poses = Array.from({ length: count }, (_, index) => sampler.sample(index / FPS));
      let plain = poses.map((pose) => retarget(pose));
      if (clip.stance) {
        // Re-time the step so the planted part lasts `stance` of it and the airborne part is shorter.
        const warp = stanceWarp(plain, clip.stance);
        poses = poses.map((_, index) => sampler.sample((warp(index) % count) / FPS));
        plain = poses.map((pose) => retarget(pose));
      }
      const shape = { stride: clip.stride ?? 1, pitch: clip.pitch ?? 0, footLift: clip.footLift ?? 1, lead: clip.lead ?? 0 };
      const reshaped = clip.bounce || clip.lift || clip.stride || clip.pitch || clip.footLift || clip.lead;
      let frames = plain;
      if (reshaped) {
        // Hips: the clip's own height, plus room for the legs under the new stride, then less bounce and any lift.
        let trial = poses.map((pose) => retarget(pose, shape));
        let toePath = null;
        if (clip.stance) {
          toePath = smoothToePath(trial);
          trial = poses.map((pose, index) => retarget(pose, { ...shape, toeZ: toePath[index] }));
        }
        const { room, ceiling } = legRoom(trial, clip.loop);
        const heights = trial.map((frame, index) => frame.rawHipsY + room[index]);
        const mean = heights.reduce((sum, value) => sum + value, 0) / heights.length;
        const count = heights.length;
        const limit = (values) => values.map((value, index) => Math.min(value, trial[index].rawHipsY + ceiling[index]));
        let hipsY = limit(heights.map((value) => mean + (value - mean) * (clip.bounce ?? 1) + (clip.lift ?? 0)));
        // Blur the corners the reach limit leaves, then apply the limit once more.
        const at = (index) => (clip.loop ? (index + count) % count : Math.min(count - 1, Math.max(0, index)));
        hipsY = limit(hipsY.map((value, index) => (hipsY[at(index - 1)] + 2 * value + hipsY[at(index + 1)]) / 4));
        if (process.env.DEBUG_CLIP === clip.name) log(`  room ${room.map((value) => value.toFixed(3)).join(' ')}`);
        frames = poses.map((pose, index) => retarget(pose, { ...shape, hipsY: hipsY[index], toeZ: toePath?.[index] }));
      }
      return { ...clip, frames, duration: count / FPS - (clip.loop ? 0 : 1 / FPS) };
    });
    clips.push(authorForwardFall(target));
    return { target, clips };
  };

  // First pass in centimetre scale to measure the idle head height, then the real scale.
  const probe = bake(0.01);
  const headIndex = probe.target.byName.get('Head');
  const headLocal = quatRotate(quatConjugate(probe.target.rest.q[headIndex]), scale(quatRotate(Y180, HEAD_CENTRE_OFFSET_CM), 0.01));
  const headHeight = (bakeResult, clipName, unit) => {
    const frames = bakeResult.clips.find((clip) => clip.name === clipName).frames;
    const heights = frames.map((frame) => {
      let p = frame.hips;
      for (const name of ['Spine', 'Spine1', 'Spine2', 'Neck', 'Head']) {
        const index = bakeResult.target.byName.get(name);
        const offset = quatRotate(quatConjugate(bakeResult.target.rest.q[bakeResult.target.joints[index].parent]), sub(bakeResult.target.rest.p[index], bakeResult.target.rest.p[bakeResult.target.joints[index].parent]));
        p = add(p, quatRotate(frame.world.get(TARGET_PARENT[name]), offset));
      }
      return add(p, quatRotate(frame.world.get('Head'), scale(headLocal, unit / 0.01)))[1];
    });
    return heights.reduce((sum, value) => sum + value, 0) / heights.length;
  };
  const factor = (0.01 * HEAD_CENTRE_HEIGHT) / headHeight(probe, 'idle', 0.01);
  const { target, clips } = bake(factor);
  log(`scale ${(factor * 100).toFixed(4)}; idle head ${headHeight({ target, clips }, 'idle', factor).toFixed(3)} m, crouch head ${headHeight({ target, clips }, 'crouchIdle', factor).toFixed(3)} m`);

  // ---- output document
  const doc = new Document();
  doc.createBuffer();
  doc.createExtension(EXTTextureWebP).setRequired(true);
  const materials = meshDoc.getRoot().listMaterials();
  const atlases = await buildAtlases(materials);
  const texture = (name, image) => doc.createTexture(name).setImage(image).setMimeType('image/webp');
  const material = doc
    .createMaterial('soldier')
    .setBaseColorTexture(texture('soldier_colour', atlases.colour))
    .setNormalTexture(texture('soldier_normal', atlases.normal))
    .setMetallicRoughnessTexture(texture('soldier_orm', atlases.orm))
    .setRoughnessFactor(1)
    .setMetallicFactor(1);

  const meshNodes = meshDoc.getRoot().listNodes().filter((node) => node.getMesh() && node.getSkin() && !SKIP_MESHES.has(node.getMesh().getName().split('_')[0]));
  const merged = mergeMeshes(meshNodes, atlases.alpha, factor);
  const accessor = (name, type, array) => doc.createAccessor(name).setType(type).setArray(array);
  const primitive = doc
    .createPrimitive()
    .setMaterial(material)
    .setIndices(accessor('indices', 'SCALAR', new Uint16Array(merged.index)))
    .setAttribute('POSITION', accessor('position', 'VEC3', new Float32Array(merged.position)))
    .setAttribute('NORMAL', accessor('normal', 'VEC3', new Float32Array(merged.normal)))
    .setAttribute('TEXCOORD_0', accessor('uv', 'VEC2', new Float32Array(merged.uv)))
    .setAttribute('JOINTS_0', accessor('joints', 'VEC4', new Uint8Array(merged.joints)))
    .setAttribute('WEIGHTS_0', accessor('weights', 'VEC4', new Float32Array(merged.weights)));
  if (merged.position.length / 3 > 65535) throw new Error('too many vertices for 16-bit indices');

  const nodes = target.joints.map((joint, index) => {
    const parentQ = joint.parent < 0 ? [0, 0, 0, 1] : target.rest.q[joint.parent];
    const parentP = joint.parent < 0 ? [0, 0, 0] : target.rest.p[joint.parent];
    return doc
      .createNode(index === 0 ? 'Root' : joint.name)
      .setRotation(quatNormalize(quatMultiply(quatConjugate(parentQ), target.rest.q[index])))
      .setTranslation(quatRotate(quatConjugate(parentQ), sub(target.rest.p[index], parentP)));
  });
  target.joints.forEach((joint, index) => {
    if (joint.parent >= 0) nodes[joint.parent].addChild(nodes[index]);
  });
  // Inverse bind = inverse of the rest world transform, except the root, whose rest lost the half turn.
  const inverseBind = new Float32Array(target.joints.length * 16);
  target.joints.forEach((_, index) => {
    const q = index === 0 ? Y180 : quatConjugate(target.rest.q[index]);
    const p = index === 0 ? [0, 0, 0] : scale(quatRotate(q, target.rest.p[index]), -1);
    const [x, y, z] = [quatRotate(q, [1, 0, 0]), quatRotate(q, [0, 1, 0]), quatRotate(q, [0, 0, 1])];
    inverseBind.set([...x, 0, ...y, 0, ...z, 0, ...p, 1], index * 16);
  });
  const outSkin = doc.createSkin('soldier').setSkeleton(nodes[0]).setInverseBindMatrices(accessor('inverseBind', 'MAT4', inverseBind));
  for (const node of nodes) outSkin.addJoint(node);
  const meshNode = doc.createNode('SoldierMesh').setMesh(doc.createMesh('soldier').addPrimitive(primitive)).setSkin(outSkin);
  doc.createScene('soldier').addChild(doc.createNode('Soldier').addChild(nodes[0]).addChild(meshNode));

  const meta = {};
  for (const clip of clips) {
    const animation = doc.createAnimation(clip.name);
    const times = accessor(`${clip.name}_times`, 'SCALAR', new Float32Array(clip.frames.map((_, index) => index / FPS)));
    const channel = (node, path, type, values) => {
      const sampler = doc.createAnimationSampler().setInput(times).setOutput(accessor(`${clip.name}_${node.getName()}_${path}`, type, new Float32Array(values))).setInterpolation('LINEAR');
      animation.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(path).setSampler(sampler));
    };
    channel(nodes[target.byName.get('Hips')], 'translation', 'VEC3', clip.frames.flatMap((frame) => frame.hips));
    for (const entry of RETARGET_MAP) {
      let previous = null;
      const values = clip.frames.flatMap((frame) => {
        let q = frame.local.get(entry.target);
        // Keep neighbouring keys in the same hemisphere so linear blending takes the short way.
        if (previous && q[0] * previous[0] + q[1] * previous[1] + q[2] * previous[2] + q[3] * previous[3] < 0) q = q.map((value) => -value);
        previous = q;
        return q;
      });
      channel(nodes[target.byName.get(entry.target)], 'rotation', 'VEC4', values);
    }
    const ankleFloor = Math.min(...clip.frames.flatMap((frame) => [frame.toes.Left[1], frame.toes.Right[1]]));
    meta[clip.name] = { duration: +clip.duration.toFixed(4), frames: clip.frames.length, loop: clip.loop };
    if (clip.gait) {
      const gait = gaitMeta(clip.frames, clip.duration);
      meta[clip.name].speed = +gait.speed.toFixed(3);
      meta[clip.name].strike = +gait.strike.toFixed(3);
    }
    // A bone that turns a long way between two frames interpolates through poses the bake never checked.
    for (const entry of RETARGET_MAP) {
      clip.frames.forEach((frame, index) => {
        const next = clip.frames[(index + 1) % clip.frames.length];
        if (!clip.loop && index === clip.frames.length - 1) return;
        const a = frame.local.get(entry.target);
        const b = next.local.get(entry.target);
        const angle = 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
        if (angle > JUMP_WARNING) log(`  warning: ${clip.name} ${entry.target} turns ${((angle * 180) / Math.PI).toFixed(0)} degrees between frames ${index} and ${index + 1}`);
      });
    }
    if (process.env.DEBUG_CLIP === clip.name) {
      // Per-frame table for tuning a gait: hips height, then each toe's height and fore-aft position.
      clip.frames.forEach((frame, index) => log(`  ${String(index).padStart(2)} hips ${frame.hips[1].toFixed(3)} L toe y ${frame.toes.Left[1].toFixed(3)} z ${frame.toes.Left[2].toFixed(3)} ankle y ${frame.ankles.Left[1].toFixed(3)} knee ${frame.legs ? `${frame.legs.Left.knee[1].toFixed(2)},${frame.legs.Left.knee[2].toFixed(2)} hip ${frame.legs.Left.hip[1].toFixed(2)},${frame.legs.Left.hip[2].toFixed(2)}` : ''} | R toe y ${frame.toes.Right[1].toFixed(3)} z ${frame.toes.Right[2].toFixed(3)} ankle y ${frame.ankles.Right[1].toFixed(3)}`));
    }
    log(`${clip.name}: ${clip.frames.length} frames, head ${headHeight({ target, clips }, clip.name, factor).toFixed(2)} m, lowest toe ${ankleFloor.toFixed(3)} m${clip.gait ? `, speed ${meta[clip.name].speed} m/s, strike ${meta[clip.name].strike}` : ''}`);
  }

  await mkdir(dirname(OUT_GLB), { recursive: true });
  const glb = await new NodeIO().registerExtensions([EXTTextureWebP]).writeBinary(doc);
  await writeFile(OUT_GLB, glb);
  const restAnkle = target.rest.p[target.byName.get('LeftFoot')][1];
  const metaSource = `// Generated by scripts/process-soldier.mjs. Do not edit by hand.

/** Clips baked into soldier.glb at ${FPS} frames per second. \`speed\` is the ground speed a gait covers at its natural rate; \`strike\` is the phase where the left foot lands. */
export const CLIP_FPS = ${FPS};

export const CLIP_META = ${JSON.stringify(meta, null, 2)} as const;

export type ClipName = keyof typeof CLIP_META;

/** Bones every clip animates, in track order after the hips translation. */
export const CLIP_BONES = ${JSON.stringify(RETARGET_MAP.map((entry) => entry.target))} as const;

/** Ankle joint height above the ground when the foot is flat, metres. */
export const ANKLE_HEIGHT = ${restAnkle.toFixed(4)};
`;
  await writeFile(OUT_META, metaSource);
  log(`${OUT_GLB}: ${(glb.length / 1024).toFixed(0)} KB, ${merged.index.length / 3} triangles (${merged.dropped} hidden dropped), ${merged.position.length / 3} vertices, ${target.joints.length} joints`);
  await buildCarbine(io);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
