import type { WeaponClass } from '../game/contracts';

/** How a class of weapon handles: switch times and where it sits at the hip. */
export interface Handling {
  /** Seconds to lower the gun out of view when switching away. */
  readonly lowerTime: number;
  /** Seconds to bring it up ready to fire. */
  readonly raiseTime: number;
  /** Grip position at the hip in view-model space (x right, y up, z back), metres. */
  readonly hip: readonly [number, number, number];
  /** Hip rotation in radians: pitch (muzzle up), yaw (muzzle left), roll (top to the left). */
  readonly hipTilt: readonly [number, number, number];
}

export const HANDLING: Readonly<Record<WeaponClass, Handling>> = {
  pistol: { lowerTime: 0.2, raiseTime: 0.25, hip: [0.11, -0.115, -0.42], hipTilt: [0.04, 0.06, -0.03] },
  smg: { lowerTime: 0.25, raiseTime: 0.3, hip: [0.12, -0.19, -0.3], hipTilt: [0.08, 0.066, -0.04] },
  carbine: { lowerTime: 0.28, raiseTime: 0.35, hip: [0.125, -0.2, -0.3], hipTilt: [0.08, 0.066, -0.04] },
  rifle: { lowerTime: 0.3, raiseTime: 0.4, hip: [0.125, -0.19, -0.28], hipTilt: [0.08, 0.066, -0.04] },
  shotgun: { lowerTime: 0.3, raiseTime: 0.4, hip: [0.125, -0.19, -0.28], hipTilt: [0.08, 0.066, -0.04] },
  sniper: { lowerTime: 0.35, raiseTime: 0.5, hip: [0.125, -0.2, -0.28], hipTilt: [0.08, 0.066, -0.04] },
  lmg: { lowerTime: 0.45, raiseTime: 0.65, hip: [0.135, -0.21, -0.3], hipTilt: [0.07, 0.066, -0.05] },
};

/** Seconds to drop into and come out of the sprint carry. */
export const SPRINT_IN_SECONDS = 0.22;
export const SPRINT_OUT_SECONDS = 0.16;
/** The gun counts as up (able to fire) once the sprint carry has blended out this far. */
export const SPRINT_READY_BLEND = 0.3;
/** After the trigger or the aim button is used, the gun stays out of the sprint carry this long. */
export const SPRINT_HOLD_OFF_SECONDS = 0.35;
