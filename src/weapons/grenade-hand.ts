/** Grenades a player carries into a match. Not refilled on respawn or resupply. */
export const GRENADES_PER_MATCH = 1;
/** Seconds for the gun to go down when the grenade comes out, and to come back up. */
const LOWER_SECONDS = 0.16;
const RAISE_SECONDS = 0.28;
/** The gun stays down this long after the throw, while the arm follows through. */
const FOLLOW_THROUGH_SECONDS = 0.3;

export interface GrenadeHandInput {
  /** The grenade key is down. */
  readonly held: boolean;
  /** Fire was pressed or another weapon was asked for: put the grenade away unused. */
  readonly cancel: boolean;
  /** false while the hands are busy (switching, reloading). */
  readonly allowed: boolean;
}

/**
 * Hold-to-aim, release-to-throw logic for the player's grenade. Pure: the
 * owner reads `aiming` and `lowered`, and throws when `update` returns true.
 */
export class GrenadeHand {
  count = 0;
  aiming = false;
  /** 0 with the gun up, 1 with it lowered out of the way. */
  lowered = 0;
  private wasHeld = false;
  private followThrough = 0;

  /** A new match: the grenade is back. */
  restock(): void {
    this.count = GRENADES_PER_MATCH;
    this.cancel();
    this.wasHeld = false;
  }

  /** Stop aiming and bring the gun straight up (death, respawn). The grenade is kept. */
  cancel(): void {
    this.aiming = false;
    this.lowered = 0;
    this.followThrough = 0;
    // A key still down does not start a new aim until it has been let go.
    this.wasHeld = true;
  }

  /** Advance one frame. Returns true on the frame the grenade leaves the hand. */
  update(dt: number, input: GrenadeHandInput): boolean {
    const pressed = input.held && !this.wasHeld;
    this.wasHeld = input.held;
    let thrown = false;
    if (this.aiming) {
      if (input.cancel || !input.allowed) {
        this.aiming = false;
      } else if (!input.held) {
        this.aiming = false;
        this.count--;
        this.followThrough = FOLLOW_THROUGH_SECONDS;
        thrown = true;
      }
    } else if (pressed && this.count > 0 && input.allowed && !input.cancel) {
      this.aiming = true;
    }
    this.followThrough = Math.max(0, this.followThrough - dt);
    const down = this.aiming || this.followThrough > 0;
    const change = down ? dt / LOWER_SECONDS : -dt / RAISE_SECONDS;
    this.lowered = Math.min(1, Math.max(0, this.lowered + change));
    return thrown;
  }
}
