/** Aim-down-sights state and the slow drift of a scoped rifle. Pure logic. */

export interface AimInput {
  readonly held: boolean;
  readonly pressed: boolean;
  /** `settings.controls.adsToggle`: press to aim, press again to stop. */
  readonly toggle: boolean;
  /** false while the gun cannot be aimed (reloading, switching, working a bolt). */
  readonly allowed: boolean;
  /** Seconds to raise the sights. */
  readonly aimTime: number;
}

/** Lowering the sights is a touch quicker than raising them. */
const LOWER_SPEEDUP = 1.25;

export class AimState {
  /** 0 at the hip, 1 fully aimed. Moves linearly; ease it where it is shown. */
  blend = 0;
  /** true while the sights are going up or are up. */
  aiming = false;
  /** true while the player is asking to aim, whether or not it is allowed right now. */
  wanted = false;
  private latched = false;

  /** Advance one frame. Returns true when `aiming` changed. */
  update(dt: number, input: AimInput): boolean {
    if (input.toggle) {
      if (input.pressed) this.latched = !this.latched;
    } else {
      this.latched = false;
    }
    this.wanted = input.toggle ? this.latched : input.held;
    const wanted = this.wanted && input.allowed;
    const changed = wanted !== this.aiming;
    this.aiming = wanted;
    const rate = dt / Math.max(0.01, input.aimTime);
    this.blend = wanted ? Math.min(1, this.blend + rate) : Math.max(0, this.blend - rate * LOWER_SPEEDUP);
    return changed;
  }

  /** Forget a toggled aim (weapon switch, sprint, death). */
  drop(): void {
    this.latched = false;
    this.wanted = false;
  }

  reset(): void {
    this.latched = false;
    this.wanted = false;
    this.aiming = false;
    this.blend = 0;
  }
}

const SWAY_RADIANS = 0.0026;
const STEADY_SCALE = 0.12;
const WINDED_SCALE = 1.9;
const HOLD_SECONDS = 4;
const RECOVER_SECONDS = 5;
/** Breath needed before it can be held again after running out. */
const RECOVERED_AT = 0.6;
const LEVEL_RATE = 5;

/**
 * Scope sway. Produces a small view offset that wanders slowly; holding the
 * breath steadies it for a few seconds, after which the shooter is winded and
 * has to recover. Apply `deltaYaw`/`deltaPitch` to the view each frame.
 */
export class BreathSway {
  /** Current offset from the true aim point, radians. */
  yaw = 0;
  pitch = 0;
  deltaYaw = 0;
  deltaPitch = 0;
  /** 1 = full lungs, 0 = out of breath. */
  breath = 1;
  exhausted = false;
  steady = false;
  private time = 0;
  private level = 0;

  /**
   * @param amount 0 - 1, how far a scoped weapon is aimed
   * @param hold the hold-breath key is down
   * @param unsteadiness 1 standing still; lower crouched, higher on the move
   */
  update(dt: number, amount: number, hold: boolean, unsteadiness: number): void {
    this.time += dt;
    const wantsHold = hold && amount > 0.5 && !this.exhausted;
    if (wantsHold) {
      this.steady = true;
      this.breath -= dt / HOLD_SECONDS;
      if (this.breath <= 0) {
        this.breath = 0;
        this.exhausted = true;
        this.steady = false;
      }
    } else {
      this.steady = false;
      this.breath = Math.min(1, this.breath + dt / RECOVER_SECONDS);
      if (this.exhausted && this.breath >= RECOVERED_AT) this.exhausted = false;
    }

    const scale = this.steady ? STEADY_SCALE : this.exhausted ? WINDED_SCALE : 1;
    const target = amount * scale * unsteadiness;
    this.level += (target - this.level) * (1 - Math.exp(-dt * LEVEL_RATE));

    const t = this.time;
    const yaw = ((Math.sin(t * 0.83) + 0.45 * Math.sin(t * 1.9 + 1.3)) / 1.45) * SWAY_RADIANS * this.level;
    const pitch = ((Math.sin(t * 1.21 + 0.6) + 0.4 * Math.sin(t * 2.7)) / 1.4) * SWAY_RADIANS * 0.75 * this.level;
    this.deltaYaw = yaw - this.yaw;
    this.deltaPitch = pitch - this.pitch;
    this.yaw = yaw;
    this.pitch = pitch;
  }

  reset(): void {
    this.breath = 1;
    this.exhausted = false;
    this.steady = false;
    this.level = 0;
    this.deltaYaw = -this.yaw;
    this.deltaPitch = -this.pitch;
    this.yaw = 0;
    this.pitch = 0;
  }
}
