/**
 * Snapshot buffer for showing another player or a bot a little in the past.
 *
 * Snapshots arrive at 12 - 30 a second, late and sometimes out of order. The
 * buffer keeps them sorted by time; `sample` blends the two around the asked
 * time, and when the newest one is already behind, carries on along its
 * velocity for a short, capped while.
 */

export interface Pose {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
}

export interface Snapshot extends Readonly<Pose> {
  /** Receiver's clock, milliseconds. */
  readonly time: number;
  /** Changes when the body teleports (a respawn): poses are never blended across a change. */
  readonly epoch: number;
}

export type SampleMode = 'empty' | 'held' | 'interpolated' | 'extrapolated' | 'stalled';

export interface SnapshotBufferOptions {
  readonly capacity?: number;
  readonly maxExtrapolationMs?: number;
  /** Work velocity out from successive positions instead of trusting the snapshot's. */
  readonly deriveVelocity?: boolean;
}

const DEFAULT_CAPACITY = 32;
export const MAX_EXTRAPOLATION_MS = 250;

/** Blend two angles the short way round. */
export function lerpAngle(from: number, to: number, t: number): number {
  const turn = Math.PI * 2;
  const difference = ((((to - from + Math.PI) % turn) + turn) % turn) - Math.PI;
  return from + difference * t;
}

function finite(snapshot: Snapshot): boolean {
  return (
    Number.isFinite(snapshot.time) &&
    Number.isFinite(snapshot.x) &&
    Number.isFinite(snapshot.y) &&
    Number.isFinite(snapshot.z) &&
    Number.isFinite(snapshot.vx) &&
    Number.isFinite(snapshot.vy) &&
    Number.isFinite(snapshot.vz) &&
    Number.isFinite(snapshot.yaw) &&
    Number.isFinite(snapshot.pitch)
  );
}

export class SnapshotBuffer {
  /** Oldest first. */
  private items: Snapshot[] = [];
  private readonly capacity: number;
  private readonly maxExtrapolationMs: number;
  private readonly deriveVelocity: boolean;

  constructor(options: SnapshotBufferOptions = {}) {
    this.capacity = Math.max(2, options.capacity ?? DEFAULT_CAPACITY);
    this.maxExtrapolationMs = options.maxExtrapolationMs ?? MAX_EXTRAPOLATION_MS;
    this.deriveVelocity = options.deriveVelocity ?? false;
  }

  get size(): number {
    return this.items.length;
  }

  /** Time of the newest snapshot, or -Infinity when empty. */
  get newestTime(): number {
    return this.items[this.items.length - 1]?.time ?? Number.NEGATIVE_INFINITY;
  }

  /** Returns false when the snapshot was refused: not finite, a duplicate, or older than the kept window. */
  push(snapshot: Snapshot): boolean {
    if (!finite(snapshot)) return false;
    const items = this.items;
    let index = items.length;
    while (index > 0 && items[index - 1]!.time > snapshot.time) index--;
    if (index > 0 && items[index - 1]!.time === snapshot.time) return false;
    if (index === 0 && items.length >= this.capacity) return false;
    const entry = this.deriveVelocity ? withVelocity(snapshot, items[index - 1]) : snapshot;
    const next = [...items.slice(0, index), entry, ...items.slice(index)];
    this.items = next.length > this.capacity ? next.slice(next.length - this.capacity) : next;
    return true;
  }

  /** Write the pose at `time` into `out` and say how it was found. */
  sample(time: number, out: Pose): SampleMode {
    const items = this.items;
    const newest = items[items.length - 1];
    if (!newest) return 'empty';

    if (time >= newest.time) {
      const ahead = time - newest.time;
      const seconds = Math.min(ahead, this.maxExtrapolationMs) / 1000;
      copyPose(newest, out);
      out.x += newest.vx * seconds;
      out.y += newest.vy * seconds;
      out.z += newest.vz * seconds;
      if (ahead <= this.maxExtrapolationMs) return ahead === 0 ? 'interpolated' : 'extrapolated';
      out.vx = out.vy = out.vz = 0;
      return 'stalled';
    }

    const oldest = items[0]!;
    if (time <= oldest.time) {
      copyPose(oldest, out);
      return 'held';
    }

    let after = items.length - 1;
    while (after > 0 && items[after - 1]!.time > time) after--;
    const a = items[after - 1]!;
    const b = items[after]!;
    if (a.epoch !== b.epoch) {
      copyPose(a, out);
      return 'held';
    }
    const t = (time - a.time) / (b.time - a.time);
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.z = a.z + (b.z - a.z) * t;
    out.vx = a.vx + (b.vx - a.vx) * t;
    out.vy = a.vy + (b.vy - a.vy) * t;
    out.vz = a.vz + (b.vz - a.vz) * t;
    out.yaw = lerpAngle(a.yaw, b.yaw, t);
    out.pitch = a.pitch + (b.pitch - a.pitch) * t;
    return 'interpolated';
  }

  reset(): void {
    this.items = [];
  }
}

function copyPose(from: Readonly<Pose>, out: Pose): void {
  out.x = from.x;
  out.y = from.y;
  out.z = from.z;
  out.vx = from.vx;
  out.vy = from.vy;
  out.vz = from.vz;
  out.yaw = from.yaw;
  out.pitch = from.pitch;
}

function withVelocity(snapshot: Snapshot, previous: Snapshot | undefined): Snapshot {
  if (!previous || previous.epoch !== snapshot.epoch) return snapshot;
  const seconds = (snapshot.time - previous.time) / 1000;
  if (seconds <= 0) return snapshot;
  return {
    ...snapshot,
    vx: (snapshot.x - previous.x) / seconds,
    vy: (snapshot.y - previous.y) / seconds,
    vz: (snapshot.z - previous.z) / seconds,
  };
}
