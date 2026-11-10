/** Death: the timeline that blends into the fall, and the dropped rifle. */
import { Object3D, Quaternion, Vector3 } from 'three/webgpu';
import { CLIP_META } from './clip-meta';

export type DeathVariant = 'back' | 'front';

export const DEATH = {
  /**
   * `back` is the library's fall onto the back. It sways on its feet before it
   * drops and falls slowly for a gunshot, so it starts `start` seconds in and
   * plays faster; `front` is the authored collapse onto the face.
   */
  variants: {
    back: { clip: 'death', rate: 1.35, start: 0.32 },
    front: { clip: 'deathFront', rate: 1, start: 0 },
  },
  /** Seconds to blend from the living pose into the fall. */
  blendTime: 0.16,
  /** Seconds for the hands to leave the rifle. */
  ikRelease: 0.14,
  /** Seconds over which the body is turned into the bullet's direction. */
  turnTime: 0.4,
  /** Most the body is turned, radians. More than this reads as a pirouette. */
  maxTurn: (70 * Math.PI) / 180,
  /** A bullet travelling within this angle of the soldier's back-to-front line knocks them onto their face. */
  frontCone: (70 * Math.PI) / 180,
} as const;

export interface DeathPlan {
  readonly variant: DeathVariant;
  /** Yaw added to the body so the fall follows the bullet, radians. */
  readonly turn: number;
}

export interface DeathFrame {
  /** Seconds into the death clip. */
  clipTime: number;
  /** 0 = pose at the moment of death, 1 = the clip. */
  blend: number;
  /** How firmly the hands still hold the rifle. */
  ikWeight: number;
  /** 0 - 1 of the turn toward the bullet's direction. */
  turn: number;
  /** The body has come to rest and needs no more posing. */
  settled: boolean;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);
const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));
const clampTurn = (angle: number): number => Math.min(DEATH.maxTurn, Math.max(-DEATH.maxTurn, angle));

/**
 * Which way to fall. `x`, `z` is the bullet's travel direction in the
 * soldier's frame (facing -Z): a shot from the front travels +Z and throws the
 * body onto its back, a shot from behind pitches it onto its face, and the
 * body is turned so the fall follows shots that come in at an angle.
 */
export function planDeath(x: number, z: number): DeathPlan {
  if (Math.hypot(x, z) < 1e-4) return { variant: 'back', turn: 0 };
  // Angle of travel from the soldier's +Z (straight through from the front).
  const angle = Math.atan2(x, z);
  if (Math.abs(angle) > Math.PI - DEATH.frontCone) {
    const offFront = angle > 0 ? angle - Math.PI : angle + Math.PI;
    return { variant: 'front', turn: clampTurn(offFront) };
  }
  return { variant: 'back', turn: clampTurn(angle) };
}

/** Where the death animation is `elapsed` seconds after the fatal hit. */
export function deathFrame(variant: DeathVariant, elapsed: number, out: DeathFrame): DeathFrame {
  const time = Math.max(0, elapsed);
  const { clip, rate, start } = DEATH.variants[variant];
  const end = CLIP_META[clip].duration;
  out.clipTime = Math.min(end, start + time * rate);
  out.blend = smooth(clamp01(time / DEATH.blendTime));
  out.ikWeight = 1 - smooth(clamp01(time / DEATH.ikRelease));
  const turn = clamp01(time / DEATH.turnTime);
  out.turn = 1 - (1 - turn) * (1 - turn);
  out.settled = start + time * rate >= end;
  return out;
}

const GRAVITY = 9.8;
/** Vertical speed of the rifle as it leaves the hands, m/s. */
const DROP_SPEED = -0.6;
/** Height of the rifle's origin when it lies on its side on the ground. */
const REST_HEIGHT = 0.035;
const spin = new Quaternion();
const flat = new Quaternion();
const forward = new Vector3();
const axis = new Vector3();

/** The rifle after its owner dies: thrown a little by the hit, falls, and comes to rest on its side. */
export class GunDrop {
  private active = false;
  private landed = false;
  private readonly velocity = new Vector3();
  private readonly spinAxis = new Vector3();
  private spinRate = 0;

  release(gun: Object3D, direction: Vector3): void {
    this.active = true;
    this.landed = false;
    // Knocked along with the bullet and already on its way down: the body reaches the ground in under half a second, and a rifle still in the air above it looks hung there.
    this.velocity.set(direction.x * 0.9, DROP_SPEED, direction.z * 0.9);
    this.spinAxis.set(0.6, 0.3, 0.7).normalize();
    this.spinRate = 5;
    void gun;
  }

  update(gun: Object3D, dt: number): void {
    if (!this.active) return;
    if (!this.landed) {
      this.velocity.y -= GRAVITY * dt;
      gun.position.addScaledVector(this.velocity, dt);
      gun.quaternion.premultiply(spin.setFromAxisAngle(this.spinAxis, this.spinRate * dt));
      if (gun.position.y > REST_HEIGHT) return;
      gun.position.y = REST_HEIGHT;
      this.landed = true;
      // Lie flat on its left side, keeping the way the barrel points across the ground.
      forward.set(0, 0, -1).applyQuaternion(gun.quaternion);
      const yaw = Math.atan2(-forward.x, -forward.z);
      flat.setFromAxisAngle(axis.set(0, 1, 0), yaw).multiply(spin.setFromAxisAngle(axis.set(0, 0, 1), Math.PI / 2));
      return;
    }
    if (gun.quaternion.angleTo(flat) < 1e-3) {
      this.active = false;
      return;
    }
    gun.quaternion.slerp(flat, Math.min(1, dt * 16));
    gun.position.x += this.velocity.x * dt * 0.3;
    gun.position.z += this.velocity.z * dt * 0.3;
    this.velocity.multiplyScalar(Math.exp(-dt * 8));
  }

  reset(): void {
    this.active = false;
    this.landed = false;
  }
}
