const TAU = Math.PI * 2;

/**
 * Screen angle of a damage source, in radians clockwise from the top of the
 * screen (0 = ahead, +90 degrees = right, 180 = behind).
 *
 * `dx`, `dz` is the horizontal direction from the player toward the source.
 * Yaw 0 looks down -Z and positive yaw turns left, so the view's forward is
 * (-sin yaw, -cos yaw) and its right is (cos yaw, -sin yaw).
 */
export function damageAngle(dx: number, dz: number, yaw: number): number {
  if (dx === 0 && dz === 0) return 0;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const ahead = -dx * sin - dz * cos;
  const right = dx * cos - dz * sin;
  return Math.atan2(right, ahead);
}

/**
 * The angle equal to `target` (mod a full turn) that is closest to `previous`,
 * so a rotating element takes the short way round instead of spinning back.
 */
export function unwrapAngle(previous: number, target: number): number {
  const delta = target - previous;
  return previous + delta - Math.round(delta / TAU) * TAU;
}

export interface HealthEffects {
  /** Opacity of the red edge vignette, 0 - 1. */
  readonly vignette: number;
  /** Colour saturation of the scene, 1 = untouched. */
  readonly saturation: number;
}

const EFFECT_START = 60;
const EFFECT_FULL = 10;
const MIN_SATURATION = 0.3;

/** How strongly the low-health treatment shows. Nothing above 60 health, full at 10 and below. */
export function healthEffects(health: number): HealthEffects {
  const t = Math.min(1, Math.max(0, (EFFECT_START - health) / (EFFECT_START - EFFECT_FULL)));
  if (t === 0) return { vignette: 0, saturation: 1 };
  return { vignette: t, saturation: 1 - (1 - MIN_SATURATION) * t };
}
