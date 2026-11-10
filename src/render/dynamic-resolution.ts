/**
 * Decides the dynamic render-scale multiplier from frame times.
 *
 * Frame intervals on a vsynced display never drop below the refresh interval,
 * so "frames are faster than the budget" cannot be used as the sign of
 * headroom: at 60 fps on a 60 Hz screen it never happens. Instead the scale
 * steps down while frames run long, and after a calm stretch it probes one
 * step back up. A probe that makes frames long again is undone and the wait
 * before the next probe doubles, so the scale settles instead of bouncing.
 * If going all the way to the floor did not make frames shorter, resolution
 * is not the bottleneck (CPU-bound, or a target above the display rate): the
 * scale is put back and left alone for a while.
 */

export const RESOLUTION_STEP = 0.05;
/** Seconds of frames judged at a time. */
const WINDOW_SECONDS = 1.5;
/** A frame counts as long when it exceeds the budget by this factor. */
const LONG_FRAME = 1.18;
/** Step down when long frames fill more than this share of a window. */
const SLOW_SHARE = 0.4;
/** A window is calm when long frames fill less than this share of it. */
const CALM_SHARE = 0.05;
/** Calm seconds before the first probe upward; doubles after each failed probe. */
const PROBE_SECONDS = 4.5;
const MAX_PROBE_SECONDS = 72;
/** Frames longer than this are hitches (shader compile, tab switch), not load. */
const HITCH_SECONDS = 0.25;
/** Going to the floor must shorten frames by at least this share to count as helping. */
const USEFUL_GAIN = 0.1;
const HOLD_SECONDS = 30;
const MAX_HOLD_SECONDS = 240;

export class DynamicResolution {
  private current = 1;
  private windowTime = 0;
  private windowFrames = 0;
  private longTime = 0;
  private calmTime = 0;
  private probeWait = PROBE_SECONDS;
  private probing = false;
  private descentFrom = 1;
  private descentFrameTime = 0;
  private descending = false;
  private hold = 0;
  private holdLength = HOLD_SECONDS;

  /** Multiplier applied to the chosen render scale, in (0, 1]. */
  get scale(): number {
    return this.current;
  }

  reset(): void {
    this.current = 1;
    this.windowTime = 0;
    this.windowFrames = 0;
    this.longTime = 0;
    this.calmTime = 0;
    this.probeWait = PROBE_SECONDS;
    this.probing = false;
    this.descending = false;
    this.hold = 0;
    this.holdLength = HOLD_SECONDS;
  }

  /**
   * Feed one frame. `dt` is the real frame interval in seconds, `budget` the
   * target interval and `floor` the lowest multiplier allowed. Returns true
   * when the scale changed.
   */
  update(dt: number, budget: number, floor: number): boolean {
    if (dt <= 0 || dt > HITCH_SECONDS) return false;
    this.windowTime += dt;
    this.windowFrames++;
    if (dt > budget * LONG_FRAME) this.longTime += dt;
    if (this.windowTime < WINDOW_SECONDS) return false;

    const windowTime = this.windowTime;
    const longShare = this.longTime / windowTime;
    const frameTime = windowTime / this.windowFrames;
    this.windowTime = 0;
    this.windowFrames = 0;
    this.longTime = 0;
    this.hold = Math.max(0, this.hold - windowTime);
    const before = this.current;

    if (longShare > SLOW_SHARE) {
      this.calmTime = 0;
      this.stepDown(floor, frameTime);
    } else {
      this.descending = false;
      if (longShare < CALM_SHARE) this.calm(windowTime);
      else this.calmTime = 0;
    }
    return this.current !== before;
  }

  private stepDown(floor: number, frameTime: number): void {
    if (this.probing) {
      // The step up was too much: undo it and wait longer before trying again.
      this.probing = false;
      this.probeWait = Math.min(MAX_PROBE_SECONDS, this.probeWait * 2);
      this.current = Math.max(floor, this.current - RESOLUTION_STEP);
      return;
    }
    if (this.hold > 0) return;
    if (!this.descending) {
      this.descending = true;
      this.descentFrom = this.current;
      this.descentFrameTime = frameTime;
    }
    if (this.current > floor + 1e-6) {
      this.current = Math.max(floor, this.current - RESOLUTION_STEP);
      return;
    }
    // At the floor and still slow. If the whole descent bought nothing, give the pixels back.
    if (this.descentFrom > this.current && frameTime > this.descentFrameTime * (1 - USEFUL_GAIN)) {
      this.current = this.descentFrom;
      this.hold = this.holdLength;
      this.holdLength = Math.min(MAX_HOLD_SECONDS, this.holdLength * 2);
    }
    this.descending = false;
  }

  private calm(seconds: number): void {
    if (this.probing) {
      // The last step up held for a whole window: there was headroom.
      this.probing = false;
      this.probeWait = PROBE_SECONDS;
    }
    if (this.current >= 1) return;
    this.calmTime += seconds;
    if (this.calmTime < this.probeWait) return;
    this.calmTime = 0;
    this.current = Math.min(1, this.current + RESOLUTION_STEP);
    this.probing = true;
  }
}
