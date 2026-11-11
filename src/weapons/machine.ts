import type { WeaponActionStage, WeaponDef, WeaponState } from '../game/contracts';
import { shotInterval } from './math';
import {
  chamberPlan,
  isManual,
  reloadPlan,
  type ActionPlan,
  type Mark,
} from './plans';

/** What the machine tells its owner. Called synchronously from `step`. */
export interface MachineSink {
  /** A round left the barrel. `lastRound` is true when it emptied the gun. */
  fire(lastRound: boolean): void;
  dryFire(): void;
  stage(stage: WeaponActionStage): void;
  /** A spent casing left the gun. */
  eject(): void;
}

export interface TriggerInput {
  readonly fireHeld: boolean;
  readonly firePressed: boolean;
  readonly reloadPressed: boolean;
  /** false while the gun is lowered (switching, sprinting). Presses wait for it. */
  readonly ready: boolean;
}

/** A press this long before the gun can fire still fires. Covers the whole cooldown of the semi-automatics. */
const PRESS_BUFFER = 0.2;

/**
 * One gun's trigger, magazine and action. Pure logic: no rendering, no input
 * devices, no events beyond the sink. `rounds` counts everything loaded,
 * including the chambered round.
 */
export class WeaponMachine implements WeaponState {
  action: ActionPlan | null = null;
  actionTime = 0;
  /** A live round is in the chamber. */
  chambered = true;

  private rounds: number;
  private reserveRounds: number;
  /** A fired case is still in the chamber (bolt guns before the action is worked). */
  private spentCase = false;
  private cooldown = 0;
  private pressBuffer = 0;
  private reloadQueued = false;
  private inReload = false;
  private readonly interval: number;
  private readonly manual: boolean;

  constructor(readonly def: WeaponDef) {
    this.rounds = def.magazineSize;
    this.reserveRounds = def.reserveAmmo;
    this.interval = shotInterval(def);
    this.manual = isManual(def);
  }

  get magazine(): number {
    return this.rounds;
  }

  get reserve(): number {
    return this.reserveRounds;
  }

  get reloading(): boolean {
    return this.inReload;
  }

  /** true while an action runs or the gun is between shots. */
  get busy(): boolean {
    return this.action !== null || this.cooldown > 0;
  }

  /** true while the firing hand is working a bolt after a shot. */
  get cycling(): boolean {
    const action = this.action;
    return (
      action !== null &&
      action.kind === 'cycle' &&
      this.actionTime >= action.handsFrom &&
      this.actionTime <= action.handsTo
    );
  }

  get canReload(): boolean {
    const keep = this.def.reloadStyle === 'magazine' && this.chambered ? 1 : 0;
    return this.reserveRounds > 0 && this.rounds < this.def.magazineSize + keep;
  }

  refill(): void {
    this.cancel();
    this.setAmmo(this.def.magazineSize, this.def.reserveAmmo);
    this.cooldown = 0;
  }

  setAmmo(rounds: number, reserve: number): void {
    this.rounds = Math.max(0, Math.floor(rounds));
    this.reserveRounds = Math.max(0, Math.floor(reserve));
    this.chambered = this.rounds > 0;
    this.spentCase = false;
  }

  /** Drop whatever the hands were doing (weapon switch, death). Ammo already loaded stays loaded. */
  cancel(): void {
    this.action = null;
    this.actionTime = 0;
    this.inReload = false;
    this.pressBuffer = 0;
    this.reloadQueued = false;
  }

  step(dt: number, input: TriggerInput, sink: MachineSink): void {
    if (input.firePressed) this.pressBuffer = PRESS_BUFFER;
    if (input.reloadPressed && !this.inReload) this.reloadQueued = true;
    // Keep at most one frame of credit so the rate of fire is exact but a pause never banks shots.
    this.cooldown = Math.max(this.cooldown - dt, -dt);
    if (this.action) this.advance(dt, sink);
    if (!input.ready) return;
    this.think(input, sink);
    if (this.pressBuffer > 0) this.pressBuffer -= dt;
  }

  private think(input: TriggerInput, sink: MachineSink): void {
    if (this.action) return;

    if (!this.chambered && this.rounds > 0) {
      this.begin(chamberPlan(this.def));
      return;
    }
    if (this.reloadQueued) {
      this.reloadQueued = false;
      if (this.canReload) {
        this.startReload();
        return;
      }
    }
    const auto = this.def.fireMode === 'auto';
    while ((this.pressBuffer > 0 || (auto && input.fireHeld)) && this.cooldown <= 0 && !this.action) {
      if (this.rounds <= 0) {
        // Only a fresh press clicks; holding the trigger on an empty gun stays quiet.
        if (this.pressBuffer > 0) {
          this.pressBuffer = 0;
          sink.dryFire();
          if (this.canReload) this.startReload();
        }
        return;
      }
      this.fire(sink);
    }
  }

  private fire(sink: MachineSink): void {
    this.pressBuffer = 0;
    this.reloadQueued = false;
    this.rounds--;
    this.cooldown += this.interval;
    const last = this.rounds === 0;
    if (this.manual) {
      this.chambered = false;
      this.spentCase = true;
      sink.fire(last);
      // The last case stays in the chamber until the reload works the action.
      if (!last) this.begin(chamberPlan(this.def));
      return;
    }
    this.chambered = !last;
    sink.fire(last);
    sink.eject();
  }

  private startReload(): void {
    this.inReload = true;
    this.reloadQueued = false;
    this.begin(reloadPlan(this.def, this.chambered));
  }

  private begin(action: ActionPlan): void {
    this.action = action;
    this.actionTime = 0;
  }

  private advance(dt: number, sink: MachineSink): void {
    let remaining = dt;
    while (this.action && remaining > 0) {
      const action = this.action;
      const from = this.actionTime;
      const to = from + remaining;
      for (let i = 0; i < action.marks.length; i++) {
        const mark = action.marks[i]!;
        if (mark.time >= from && mark.time < to) this.applyMark(mark, sink);
      }
      if (to < action.duration) {
        this.actionTime = to;
        return;
      }
      remaining = to - action.duration;
      this.action = null;
      this.actionTime = 0;
      this.inReload = false;
    }
  }

  private applyMark(mark: Mark, sink: MachineSink): void {
    if (mark.stage) sink.stage(mark.stage);
    switch (mark.effect) {
      case 'eject':
        if (this.spentCase) {
          this.spentCase = false;
          sink.eject();
        }
        break;
      case 'chamber':
        this.chambered = this.rounds > 0;
        break;
      case 'fill': {
        const keep = this.def.reloadStyle === 'magazine' && this.chambered ? 1 : 0;
        const pool = this.reserveRounds + this.rounds - keep;
        const take = Math.min(this.def.magazineSize, pool);
        this.rounds = keep + take;
        this.reserveRounds = pool - take;
        break;
      }
      default:
        break;
    }
  }
}
