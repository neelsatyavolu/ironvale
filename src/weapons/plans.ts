import type { WeaponActionStage, WeaponDef } from '../game/contracts';
import { shotInterval } from './math';

/**
 * Timelines for everything the hands do to a gun besides pulling the trigger:
 * working a bolt, and each kind of reload. A plan is a duration and a
 * list of marks; each mark can announce a stage (sound and animation key off
 * it) and change the gun's state.
 */
export type PlanKind = 'cycle' | 'charge' | 'reload';

export type MarkEffect =
  /** The spent case leaves the gun. */
  | 'eject'
  /** A live round is in the chamber; the gun can fire. */
  | 'chamber'
  /** The fresh magazine or belt is in. */
  | 'fill';

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
/** A magazine swap with a round still chambered skips the bolt work, so it is quicker. */
const TACTICAL_FACTOR = 0.78;
const BOLT_TOP_UP_FACTOR = 0.62;

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

function isManual(def: WeaponDef): boolean {
  return def.fireMode === 'bolt';
}

/** Stage that puts a round in the chamber of a self-loading gun. */
function chargeStage(def: WeaponDef): WeaponActionStage {
  // The M249 fires from an open bolt: charging it means pulling the bolt back.
  if (def.reloadStyle === 'belt') return 'boltBack';
  return 'boltForward';
}

function buildChamberPlan(def: WeaponDef): ActionPlan {
  if (def.fireMode === 'bolt') return plan('cycle', shotInterval(def), BOLT_CYCLE);
  return plan('charge', CHARGE_SECONDS, [[0.5, chargeStage(def), 'chamber']]);
}

function buildReload(def: WeaponDef, chambered: boolean): ActionPlan {
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
  }
}

interface PlanSet {
  readonly chamber: ActionPlan;
  readonly reloadChambered: ActionPlan;
  readonly reloadEmpty: ActionPlan;
}

const cache = new Map<WeaponDef, PlanSet>();

function plansFor(def: WeaponDef): PlanSet {
  const existing = cache.get(def);
  if (existing) return existing;
  const built: PlanSet = {
    chamber: buildChamberPlan(def),
    reloadChambered: buildReload(def, true),
    reloadEmpty: buildReload(def, false),
  };
  cache.set(def, built);
  return built;
}

/** Work the bolt, or charge a self-loader whose chamber is empty. */
export function chamberPlan(def: WeaponDef): ActionPlan {
  return plansFor(def).chamber;
}

/** Reload for the gun as it stands. */
export function reloadPlan(def: WeaponDef, chambered: boolean): ActionPlan {
  const plans = plansFor(def);
  return chambered ? plans.reloadChambered : plans.reloadEmpty;
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
