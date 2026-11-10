/**
 * Decides how often a soldier's skeleton is posed. Posing (clip sampling,
 * aim, arm IK) is the per-soldier CPU cost; distant and unseen soldiers do it
 * less often and settled corpses not at all.
 */

export const LOD = {
  /** Beyond this many metres a visible soldier is posed every second frame. */
  midDistance: 28,
  midInterval: 2,
  /** Beyond this, every third frame. */
  farDistance: 60,
  farInterval: 3,
  /**
   * Soldiers the camera does not see still tick slowly: they may cast a shadow
   * into view, and bots read the muzzle position to start tracers.
   */
  hiddenInterval: 6,
  /** Frames without being drawn before a soldier counts as unseen. */
  hiddenAfterFrames: 3,
} as const;

/** Frames between skeleton updates. */
export function poseInterval(visible: boolean, distance: number): number {
  if (!visible) return LOD.hiddenInterval;
  if (distance > LOD.farDistance) return LOD.farInterval;
  if (distance > LOD.midDistance) return LOD.midInterval;
  return 1;
}

/** true on the frames a soldier in `slot` should pose; slots spread the work across frames. */
export function shouldPose(frame: number, slot: number, interval: number): boolean {
  return interval <= 1 || (frame + slot) % interval === 0;
}

/**
 * Tracks whether the main camera drew the soldier recently. The renderer calls
 * `seen` from the mesh's `onBeforeRender`, which only runs for objects inside
 * the view frustum; `tick` runs once per update.
 */
export class VisibilityTracker {
  distance = 0;
  private sinceSeen = 0;

  get visible(): boolean {
    return this.sinceSeen <= LOD.hiddenAfterFrames;
  }

  seen(distance: number): void {
    this.sinceSeen = 0;
    this.distance = distance;
  }

  tick(): void {
    this.sinceSeen++;
  }
}
