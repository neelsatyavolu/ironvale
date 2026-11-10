/**
 * Clip storage and pose blending on flat arrays. Every clip in soldier.glb is
 * baked at a fixed frame rate over the same bones, so sampling is an index and
 * a lerp: no mixer, no per-frame allocation, and soldiers share the clip data.
 */

export interface ClipTrack {
  /** `<bone>.quaternion` or `Hips.position`, as the glTF loader names them. */
  readonly name: string;
  readonly values: ArrayLike<number>;
}

export interface ClipData {
  readonly bones: number;
  readonly frames: number;
  readonly fps: number;
  readonly loop: boolean;
  /** Seconds for one pass. A loop's last frame leads back into its first. */
  readonly duration: number;
  /** frames x bones x 4. */
  readonly rotations: Float32Array;
  /** frames x 3. */
  readonly hips: Float32Array;
}

/** Local rotation of each animated bone plus the hips position. */
export class Pose {
  readonly rotations: Float32Array;
  readonly hips = new Float32Array(3);

  constructor(readonly bones: number) {
    this.rotations = new Float32Array(bones * 4);
    for (let i = 0; i < bones; i++) this.rotations[i * 4 + 3] = 1;
  }
}

export function buildClipData(source: { bones: readonly string[]; fps: number; loop: boolean; tracks: readonly ClipTrack[] }): ClipData {
  const { bones, fps, loop, tracks } = source;
  const find = (name: string): ArrayLike<number> => {
    const track = tracks.find((item) => item.name === name);
    if (!track) throw new Error(`Soldier clip is missing the track "${name}"`);
    return track.values;
  };
  const hipsValues = find('Hips.position');
  const frames = hipsValues.length / 3;
  const rotations = new Float32Array(frames * bones.length * 4);
  bones.forEach((bone, index) => {
    const values = find(`${bone}.quaternion`);
    for (let frame = 0; frame < frames; frame++) {
      for (let k = 0; k < 4; k++) rotations[(frame * bones.length + index) * 4 + k] = values[frame * 4 + k]!;
    }
  });
  return {
    bones: bones.length,
    frames,
    fps,
    loop,
    duration: (loop ? frames : frames - 1) / fps,
    rotations,
    hips: Float32Array.from(hipsValues),
  };
}

/** Writes the clip's pose at `time` seconds into `out`. Loops wrap; one-shots hold their ends. */
export function sampleClip(clip: ClipData, time: number, out: Pose): void {
  const { frames, bones, rotations, hips } = clip;
  let position = time * clip.fps;
  let a: number;
  let b: number;
  if (clip.loop) {
    position -= Math.floor(position / frames) * frames;
    a = Math.floor(position) % frames;
    b = (a + 1) % frames;
  } else {
    position = Math.min(frames - 1, Math.max(0, position));
    a = Math.floor(position);
    b = Math.min(frames - 1, a + 1);
  }
  const mix = position - Math.floor(position);
  const rowA = a * bones * 4;
  const rowB = b * bones * 4;
  const target = out.rotations;
  for (let i = 0; i < bones * 4; i += 4) {
    lerpQuat(target, i, rotations, rowA + i, rotations, rowB + i, mix);
  }
  for (let k = 0; k < 3; k++) out.hips[k] = hips[a * 3 + k]! + (hips[b * 3 + k]! - hips[a * 3 + k]!) * mix;
}

/** `out` moves `weight` of the way toward `other`. */
export function blendPose(out: Pose, other: Pose, weight: number): void {
  if (weight <= 0) return;
  const target = out.rotations;
  for (let i = 0; i < target.length; i += 4) lerpQuat(target, i, target, i, other.rotations, i, weight);
  for (let k = 0; k < 3; k++) out.hips[k] = out.hips[k]! + (other.hips[k]! - out.hips[k]!) * weight;
}

/** Pulls one bone's rotation `weight` of the way toward `target`. */
export function steerBone(pose: Pose, bone: number, target: { x: number; y: number; z: number; w: number }, weight: number): void {
  if (weight <= 0) return;
  scratch[0] = target.x;
  scratch[1] = target.y;
  scratch[2] = target.z;
  scratch[3] = target.w;
  lerpQuat(pose.rotations, bone * 4, pose.rotations, bone * 4, scratch, 0, weight);
}

export function copyPose(out: Pose, from: Pose): void {
  out.rotations.set(from.rotations);
  out.hips.set(from.hips);
}

const scratch = new Float32Array(4);

/** Normalised lerp along the shorter arc. */
function lerpQuat(out: Float32Array, o: number, a: Float32Array, i: number, b: Float32Array, j: number, mix: number): void {
  const ax = a[i]!;
  const ay = a[i + 1]!;
  const az = a[i + 2]!;
  const aw = a[i + 3]!;
  const sign = ax * b[j]! + ay * b[j + 1]! + az * b[j + 2]! + aw * b[j + 3]! < 0 ? -mix : mix;
  const keep = 1 - mix;
  const x = ax * keep + b[j]! * sign;
  const y = ay * keep + b[j + 1]! * sign;
  const z = az * keep + b[j + 2]! * sign;
  const w = aw * keep + b[j + 3]! * sign;
  const scale = 1 / (Math.hypot(x, y, z, w) || 1);
  out[o] = x * scale;
  out[o + 1] = y * scale;
  out[o + 2] = z * scale;
  out[o + 3] = w * scale;
}
