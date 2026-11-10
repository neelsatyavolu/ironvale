import type { Vector3 } from 'three/webgpu';
import type { Combatant } from '../game/contracts';

/**
 * Aim assist for trackpads. Three gentle effects, all scaled by the setting:
 * the turn slows while the reticle is on or near a visible enemy, the view
 * drifts toward that enemy's chest while the player is turning roughly that
 * way, and raising the sights near an enemy eases part of the way onto them.
 * It never turns the view on its own and never outruns the player's hand.
 */
export type AssistTarget = Pick<Combatant, 'id' | 'alive' | 'crouching' | 'position'>;

export interface AssistFrame {
  readonly dt: number;
  /** `settings.controls.aimAssist`, 0 - 1. */
  readonly strength: number;
  readonly yaw: number;
  readonly pitch: number;
  /** How far the player's own hand turned the view this frame, radians. */
  readonly inputYaw: number;
  readonly inputPitch: number;
  /** Current field of view multiplier (1 at the hip). The cone shrinks with it. */
  readonly zoom: number;
  /** true on the frame the sights start to come up. */
  readonly aimStarted: boolean;
  readonly aimTime: number;
  readonly eye: Vector3;
  readonly targets: readonly AssistTarget[];
  /** Line of sight from the eye to a point. Called at most twice a frame. */
  visible(eye: Vector3, point: Vector3): boolean;
}

const DEG = Math.PI / 180;
const CONE = 3 * DEG;
const SNAP_CONE = 6 * DEG;
const MAX_RANGE = 120;
const MIN_RANGE = 0.8;
const BODY_RADIUS = 0.32;
const CHEST_STANDING = 1.25;
const CHEST_CROUCHING = 0.72;
/** Share of the player's turn removed when dead on target, at full strength. */
const SLOW_MAX = 0.4;
/** Pull per unit of the player's own turn, at full strength. */
const PULL_MAX = 0.35;
/** Share of the gap to the chest closed while the sights come up, at full strength. */
const SNAP_FRACTION = 0.6;
const MIN_SNAP_SECONDS = 0.15;
/** A turn this large against the snap direction cancels it. */
const SNAP_CANCEL_INPUT = 0.0015;
const MIN_INPUT = 1e-5;

interface Candidate {
  target: AssistTarget | null;
  /** Angle from the reticle to the edge of the body; negative when on the body. */
  edge: number;
  errorX: number;
  errorY: number;
  x: number;
  y: number;
  z: number;
}

function emptyCandidate(): Candidate {
  return { target: null, edge: Infinity, errorX: 0, errorY: 0, x: 0, y: 0, z: 0 };
}

function wrapAngle(angle: number): number {
  return angle - Math.round(angle / (Math.PI * 2)) * Math.PI * 2;
}

export class AimAssist {
  /** Radians to pass to `PlayerBody.nudgeView` this frame. */
  nudgeYaw = 0;
  nudgePitch = 0;
  /** Diagnostics for the last frame: share of the turn removed, radians pulled, target id or -1. */
  slowdown = 0;
  pull = 0;
  targetId = -1;

  private snapLeft = 0;
  private snapRate = 0;
  private snapTargetId = -1;
  private readonly best = emptyCandidate();
  private readonly second = emptyCandidate();
  private readonly probe = emptyCandidate();
  private point: Vector3 | null = null;

  reset(): void {
    this.snapLeft = 0;
    this.snapTargetId = -1;
    this.nudgeYaw = this.nudgePitch = this.slowdown = this.pull = 0;
    this.targetId = -1;
  }

  update(frame: AssistFrame): void {
    this.nudgeYaw = this.nudgePitch = this.slowdown = this.pull = 0;
    this.targetId = -1;
    const strength = Math.min(1, Math.max(0, frame.strength));
    if (strength <= 0) {
      this.snapLeft = 0;
      return;
    }
    const cosPitch = Math.max(0.2, Math.cos(frame.pitch));
    const inputX = frame.inputYaw * cosPitch;
    const inputY = frame.inputPitch;
    const inputSize = Math.hypot(inputX, inputY);
    const snapping = frame.aimStarted || this.snapLeft > 0;
    // Nothing to do unless the player is turning or the sights are coming up.
    if (inputSize < MIN_INPUT && !snapping) return;

    const cone = CONE * frame.zoom;
    const chosen = this.choose(frame, snapping ? Math.max(cone, SNAP_CONE * frame.zoom) : cone, cosPitch);
    if (!chosen) {
      this.snapLeft = 0;
      return;
    }
    const target = chosen.target;
    if (!target) return;
    this.targetId = target.id;
    const errorSize = Math.hypot(chosen.errorX, chosen.errorY);
    const towardX = errorSize > 1e-9 ? chosen.errorX / errorSize : 0;
    const towardY = errorSize > 1e-9 ? chosen.errorY / errorSize : 0;
    let nudgeX = 0;
    let nudgeY = 0;

    if (frame.aimStarted) {
      const seconds = Math.max(MIN_SNAP_SECONDS, frame.aimTime);
      this.snapLeft = seconds;
      this.snapRate = -Math.log(1 - SNAP_FRACTION * strength) / seconds;
      this.snapTargetId = target.id;
    }
    if (this.snapLeft > 0) {
      const against = inputX * towardX + inputY * towardY < -SNAP_CANCEL_INPUT;
      if (against || target.id !== this.snapTargetId) {
        this.snapLeft = 0;
      } else {
        const share = 1 - Math.exp(-this.snapRate * Math.min(frame.dt, this.snapLeft));
        nudgeX += chosen.errorX * share;
        nudgeY += chosen.errorY * share;
        this.snapLeft -= frame.dt;
      }
    }

    if (inputSize >= MIN_INPUT && chosen.edge < cone) {
      // 1 on the body, falling to 0 at the edge of the cone.
      const closeness = chosen.edge <= 0 ? 1 : 1 - chosen.edge / cone;
      // Friction is strongest on target; the pull reaches further out so it helps the approach.
      this.slowdown = SLOW_MAX * strength * closeness ** 1.5;
      nudgeX -= inputX * this.slowdown;
      nudgeY -= inputY * this.slowdown;
      const alignment = Math.min(1, Math.max(0, 0.5 + (inputX * towardX + inputY * towardY) / inputSize));
      this.pull = Math.min(errorSize, PULL_MAX * strength * Math.sqrt(closeness) * alignment * inputSize);
      nudgeX += towardX * this.pull;
      nudgeY += towardY * this.pull;
    }

    this.nudgeYaw = nudgeX / cosPitch;
    this.nudgePitch = nudgeY;
  }

  /** Nearest target to the reticle that is inside `limit` and in view. */
  private choose(frame: AssistFrame, limit: number, cosPitch: number): Candidate | null {
    const best = this.best;
    const second = this.second;
    best.target = second.target = null;
    best.edge = second.edge = Infinity;
    for (let i = 0; i < frame.targets.length; i++) {
      const target = frame.targets[i]!;
      if (!target.alive) continue;
      const probe = this.measure(frame, target, cosPitch);
      if (!probe || probe.edge >= limit) continue;
      if (probe.edge < best.edge) {
        copyCandidate(second, best);
        copyCandidate(best, probe);
      } else if (probe.edge < second.edge) {
        copyCandidate(second, probe);
      }
    }
    // Two sight checks a frame at most: the nearest candidate, then the runner-up.
    if (this.inView(frame, best)) return best;
    if (this.inView(frame, second)) return second;
    return null;
  }

  private inView(frame: AssistFrame, candidate: Candidate): boolean {
    if (!candidate.target) return false;
    const point = (this.point ??= frame.eye.clone());
    point.set(candidate.x, candidate.y, candidate.z);
    return frame.visible(frame.eye, point);
  }

  private measure(frame: AssistFrame, target: AssistTarget, cosPitch: number): Candidate | null {
    const probe = this.probe;
    probe.x = target.position.x;
    probe.y = target.position.y + (target.crouching ? CHEST_CROUCHING : CHEST_STANDING);
    probe.z = target.position.z;
    const dx = probe.x - frame.eye.x;
    const dy = probe.y - frame.eye.y;
    const dz = probe.z - frame.eye.z;
    const flat = Math.hypot(dx, dz);
    const distance = Math.hypot(flat, dy);
    if (distance < MIN_RANGE || distance > MAX_RANGE) return null;
    // Yaw 0 looks down -Z and positive yaw turns left.
    probe.errorX = wrapAngle(Math.atan2(-dx, -dz) - frame.yaw) * cosPitch;
    probe.errorY = Math.atan2(dy, flat) - frame.pitch;
    probe.edge = Math.hypot(probe.errorX, probe.errorY) - Math.atan(BODY_RADIUS / distance);
    probe.target = target;
    return probe;
  }
}

function copyCandidate(into: Candidate, from: Candidate): void {
  into.target = from.target;
  into.edge = from.edge;
  into.errorX = from.errorX;
  into.errorY = from.errorY;
  into.x = from.x;
  into.y = from.y;
  into.z = from.z;
}
