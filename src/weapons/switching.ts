/** Lower and raise times for one weapon. */
export interface SwitchTimes {
  readonly lowerTime: number;
  readonly raiseTime: number;
}

/**
 * Swapping guns: the one in hand goes down for its lower time, then the next
 * comes up for its raise time. Changing your mind part-way works from wherever
 * the gun is. Pure logic; the owner reacts to the return values.
 */
export class WeaponSwitch {
  /** Weapon in the hands. */
  index = 0;
  private target = 0;
  private phase: 'none' | 'lowering' | 'raising' = 'none';
  private time = 0;

  constructor(
    private readonly count: number,
    private readonly timesOf: (index: number) => SwitchTimes,
  ) {}

  get switching(): boolean {
    return this.phase !== 'none';
  }

  /** Weapon that will be in hand once the switch finishes. */
  get pending(): number {
    return this.target;
  }

  /** 0 with the gun up, 1 with it fully lowered. */
  get lowered(): number {
    if (this.phase === 'none') return 0;
    const times = this.timesOf(this.index);
    const progress = Math.min(1, this.time / (this.phase === 'lowering' ? times.lowerTime : times.raiseTime));
    return this.phase === 'lowering' ? progress : 1 - progress;
  }

  /** Ask for another weapon. Returns true when the gun in hand starts going down because of it. */
  request(index: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) return false;
    if (this.phase === 'lowering') {
      this.target = index;
      return false;
    }
    if (index === this.index) return false;
    // Raising: turn round from however far up the gun already is.
    const raised = this.phase === 'raising' ? Math.min(1, this.time / this.timesOf(this.index).raiseTime) : 1;
    this.phase = 'lowering';
    this.time = this.timesOf(this.index).lowerTime * (1 - raised);
    this.target = index;
    return true;
  }

  /** Advance. Returns true on the frame a different weapon comes into the hands. */
  update(dt: number): boolean {
    if (this.phase === 'none') return false;
    this.time += dt;
    if (this.phase === 'raising') {
      if (this.time >= this.timesOf(this.index).raiseTime) this.phase = 'none';
      return false;
    }
    if (this.time < this.timesOf(this.index).lowerTime) return false;
    const changed = this.target !== this.index;
    this.index = this.target;
    this.phase = 'raising';
    this.time = 0;
    return changed;
  }

  /** Put a weapon straight into the hands, with no lowering or raising. */
  hold(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.count) return;
    this.index = index;
    this.reset();
  }

  /** Gun up and ready, with whatever is in hand. */
  reset(): void {
    this.phase = 'none';
    this.time = 0;
    this.target = this.index;
  }
}
