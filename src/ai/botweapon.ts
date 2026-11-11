import type { WeaponDef } from '../game/contracts';

/** How a soldier works the trigger. Lengths in rounds, pauses in seconds. */
export interface BurstTiming {
  readonly burstMin: number;
  readonly burstMax: number;
  readonly pauseMin: number;
  readonly pauseMax: number;
}

const EPSILON = 1e-6;

/**
 * A bot's gun: rate of fire, bursts with pauses between them, a magazine and
 * reloads. Pure timing with no world access, so it can be tested on its own.
 */
export class BotWeapon {
  magazine: number;
  reloading = false;
  /** true for the one update in which a reload began or ended. */
  reloadStarted = false;
  reloadFinished = false;
  private cooldown = 0;
  private pause = 0;
  private burstLeft = 0;
  private reloadLeft = 0;
  private reloadTotal = 0;

  constructor(
    readonly def: WeaponDef,
    private readonly timing: BurstTiming,
    private readonly random: () => number,
  ) {
    this.magazine = def.magazineSize;
  }

  /** Seconds the reload in progress (or the next one) takes. */
  get reloadDuration(): number {
    if (this.reloading) return this.reloadTotal;
    return this.def.reloadTime;
  }

  /** true while waiting between bursts. */
  get pausing(): boolean {
    return this.pause > 0;
  }

  /**
   * Advance by `dt`. `trigger` is whether the soldier wants to shoot. Returns
   * true when one round leaves the barrel in this update.
   */
  update(dt: number, trigger: boolean): boolean {
    this.reloadStarted = false;
    this.reloadFinished = false;
    if (this.reloading) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= EPSILON) {
        this.reloading = false;
        this.reloadFinished = true;
        this.magazine = this.def.magazineSize;
        this.cooldown = 0;
        this.pause = 0;
      }
      return false;
    }
    if (this.magazine <= 0) {
      this.startReload();
      return false;
    }

    let fired = false;
    if (!trigger) {
      this.burstLeft = 0;
    } else if (this.pause <= EPSILON && this.cooldown <= EPSILON) {
      const interval = 60 / this.def.roundsPerMinute;
      if (this.burstLeft <= 0) {
        const { burstMin, burstMax } = this.timing;
        this.burstLeft = burstMin + Math.floor(this.random() * (burstMax - burstMin + 1));
        this.cooldown = interval;
      } else {
        // Carry the overshoot so the rate of fire does not depend on the frame rate.
        this.cooldown += interval;
      }
      this.magazine--;
      this.burstLeft--;
      fired = true;
      if (this.burstLeft <= 0) {
        this.pause = this.timing.pauseMin + this.random() * (this.timing.pauseMax - this.timing.pauseMin);
      }
    }
    this.pause = Math.max(0, this.pause - dt);
    this.cooldown = Math.max(-dt, this.cooldown - dt);
    return fired;
  }

  /** Begin a reload unless the magazine is already full. */
  startReload(): void {
    if (this.reloading || this.magazine >= this.def.magazineSize) return;
    this.reloadTotal = this.reloadDuration;
    this.reloadLeft = this.reloadTotal;
    this.reloading = true;
    this.reloadStarted = true;
    this.burstLeft = 0;
  }
}
