import type { WeaponActionStage, WeaponDef } from '../game/contracts';
import { shotInterval } from './math';

/**
 * Timelines for everything the hands do to a gun besides pulling the trigger:
 * working a bolt or pump, and each kind of reload. A plan is a duration and a
 * list of marks; each mark can announce a stage (sound and animation key off
 * it) and change the gun's state.
 */
export type PlanKind = 'cycle' | 'charge' | 'reload' | 'shellStart' | 'shell' | 'shellEnd';

export type MarkEffect =
  /** The spent case leaves the gun. */
  | 'eject'
  /** A live round is in the chamber; the gun can fire. */
  | 'chamber'
  /** The fresh magazine, clip or belt is in. */
  | 'fill'
  /** A partly used clip comes out; its rounds go back to the reserve. */
  | 'unload'
  /** One shell goes into the tube. */
  | 'shell';

export interface Mark {
  /** Seconds from the start of the plan. */
  readonly time: number;
  readonly stage?: WeaponActionStage;
  readonly effect?: MarkEffect;
}

export interface ActionPlan {
  readonly kind: PlanKind;
  readonly duration: number;
  readonly marks: readonly Mark[];
  /** Window in which the firing hand is off the grip (a scope cannot be held). */
  readonly handsFrom: number;
  readonly handsTo: number;
}

type MarkSpec = readonly [fraction: number, stage: WeaponActionStage, effect?: MarkEffect];

const HANDS_LEAD = 0.1;
const HANDS_TAIL = 0.08;
const CHARGE_SECONDS = 0.45;
const SHELL_START_SECONDS = 0.32;
const SHELL_END_SECONDS = 0.22;
const SHELL_INSERT_AT = 0.55;
/** A magazine swap with a round still chambered skips the bolt work, so it is quicker. */
const TACTICAL_FACTOR = 0.78;
const BOLT_TOP_UP_FACTOR = 0.62;
const PARTIAL_CLIP_FACTOR = 1.2;

function plan(kind: PlanKind, duration: number, specs: readonly MarkSpec[]): ActionPlan {
  const marks = specs.map(([fraction, stage, effect]): Mark => ({ time: fraction * duration, stage, effect }));
  const first = marks[0]?.time ?? 0;
  const last = marks[marks.length - 1]?.time ?? duration;
  return {
    kind,
    duration,
    marks,
    handsFrom: Math.max(0, first - HANDS_LEAD),
    handsTo: Math.min(duration, last + HANDS_TAIL),
  };
}

const BOLT_CYCLE: readonly MarkSpec[] = [
  [0.2, 'boltLift'],
  [0.36, 'boltBack', 'eject'],
  [0.62, 'boltForward'],
  [0.8, 'boltClose', 'chamber'],
];

const PUMP_CYCLE: readonly MarkSpec[] = [
  [0.3, 'pumpBack', 'eject'],
  [0.6, 'pumpForward', 'chamber'],
];

function isManual(def: WeaponDef): boolean {
  return def.fireMode === 'bolt' || def.fireMode === 'pump';
}

/** Stage that puts a round in the chamber of a self-loading gun. */
function chargeStage(def: WeaponDef): WeaponActionStage {
  if (def.weaponClass === 'pistol') return 'slideRelease';
  // The M249 fires from an open bolt: charging it means pulling the bolt back.
  if (def.reloadStyle === 'belt') return 'boltBack';
  return 'boltForward';
}

function buildChamberPlan(def: WeaponDef): ActionPlan {
  if (def.fireMode === 'bolt') return plan('cycle', shotInterval(def), BOLT_CYCLE);
  if (def.fireMode === 'pump') return plan('cycle', shotInterval(def), PUMP_CYCLE);
  return plan('charge', CHARGE_SECONDS, [[0.5, chargeStage(def), 'chamber']]);
}

function buildReload(def: WeaponDef, chambered: boolean, rounds: number): ActionPlan {
  const full = def.reloadTime;
  switch (def.reloadStyle) {
    case 'magazine':
      if (def.fireMode === 'bolt') {
        return chambered
          ? plan('reload', full * BOLT_TOP_UP_FACTOR, [
              [0.2, 'magOut'],
              [0.7, 'magIn', 'fill'],
            ])
          : plan('reload', full, [
              [0.12, 'magOut'],
              [0.42, 'magIn', 'fill'],
              [0.58, 'boltLift'],
              [0.68, 'boltBack', 'eject'],
              [0.82, 'boltForward'],
              [0.92, 'boltClose', 'chamber'],
            ]);
      }
      return chambered
        ? plan('reload', full * TACTICAL_FACTOR, [
            [0.2, 'magOut'],
            [0.7, 'magIn', 'fill'],
          ])
        : plan('reload', full, [
            [0.16, 'magOut'],
            [0.56, 'magIn', 'fill'],
            [0.82, chargeStage(def), 'chamber'],
          ]);
    case 'enbloc':
      return rounds > 0
        ? plan('reload', full * PARTIAL_CLIP_FACTOR, [
            [0.1, 'boltBack'],
            [0.26, 'magOut', 'unload'],
            [0.62, 'clipInsert', 'fill'],
            [0.84, 'boltForward', 'chamber'],
          ])
        : plan('reload', full, [
            [0.55, 'clipInsert', 'fill'],
            [0.8, 'boltForward', 'chamber'],
          ]);
    case 'belt': {
      const marks: MarkSpec[] = [
        [0.1, 'beltOpen'],
        [0.26, 'magOut'],
        [0.5, 'magIn', 'fill'],
        [0.8, 'beltClose'],
      ];
      if (!chambered) marks.push([0.9, 'boltBack', 'chamber']);
      return plan('reload', full, marks);
    }
    case 'single-shell':
      return plan('shell', full, [[SHELL_INSERT_AT, 'shellInsert', 'shell']]);
  }
}

interface PlanSet {
  readonly chamber: ActionPlan;
  readonly reloadChambered: ActionPlan;
  readonly reloadEmpty: ActionPlan;
  readonly shellStart: ActionPlan;
  readonly shellEnd: ActionPlan;
}

const cache = new Map<WeaponDef, PlanSet>();

function plansFor(def: WeaponDef): PlanSet {
  const existing = cache.get(def);
  if (existing) return existing;
  const built: PlanSet = {
    chamber: buildChamberPlan(def),
    reloadChambered: buildReload(def, true, 1),
    reloadEmpty: buildReload(def, false, 0),
    shellStart: plan('shellStart', SHELL_START_SECONDS, []),
    shellEnd: plan('shellEnd', SHELL_END_SECONDS, []),
  };
  cache.set(def, built);
  return built;
}

/** Work the action (bolt or pump), or charge a self-loader whose chamber is empty. */
export function chamberPlan(def: WeaponDef): ActionPlan {
  return plansFor(def).chamber;
}

/** Reload for the gun as it stands. For `single-shell` this is one shell; the machine repeats it. */
export function reloadPlan(def: WeaponDef, chambered: boolean, rounds: number): ActionPlan {
  const plans = plansFor(def);
  if (def.reloadStyle === 'enbloc') return rounds > 0 ? plans.reloadChambered : plans.reloadEmpty;
  return chambered ? plans.reloadChambered : plans.reloadEmpty;
}

export function shellStartPlan(def: WeaponDef): ActionPlan {
  return plansFor(def).shellStart;
}

export function shellEndPlan(def: WeaponDef): ActionPlan {
  return plansFor(def).shellEnd;
}

/** Time of the first mark announcing `stage`, or -1 when the plan has none. */
export function markTime(action: ActionPlan, stage: WeaponActionStage): number {
  for (let i = 0; i < action.marks.length; i++) {
    const mark = action.marks[i]!;
    if (mark.stage === stage) return mark.time;
  }
  return -1;
}

export { isManual };
