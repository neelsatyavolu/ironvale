import type { WEAPON_DEFS } from '../weapons/defs';

export type BotRole = 'rifleman' | 'rusher' | 'breacher' | 'marksman' | 'gunner';

export interface RoleDef {
  readonly weapon: keyof typeof WEAPON_DEFS;
  /** Closer than this and the soldier backs off. Metres. */
  readonly minRange: number;
  /** The distance the soldier tries to fight from. */
  readonly idealRange: number;
  /** Further than this and the soldier closes in before engaging. */
  readonly maxRange: number;
  /** Rounds per burst, before the difficulty multiplier. */
  readonly burstMin: number;
  readonly burstMax: number;
  /** Seconds between bursts, before the difficulty multiplier. */
  readonly pauseMin: number;
  readonly pauseMax: number;
  /** Closes distance instead of trading fire from range. */
  readonly pushes: boolean;
  /** Picks a spot and fights from it. */
  readonly holds: boolean;
}

export const ROLES: Readonly<Record<BotRole, RoleDef>> = {
  rifleman: { weapon: 'm4a1', minRange: 8, idealRange: 24, maxRange: 55, burstMin: 3, burstMax: 5, pauseMin: 0.5, pauseMax: 1.1, pushes: false, holds: false },
  rusher: { weapon: 'mp5', minRange: 4, idealRange: 11, maxRange: 22, burstMin: 4, burstMax: 8, pauseMin: 0.3, pauseMax: 0.7, pushes: true, holds: false },
  breacher: { weapon: 'r870', minRange: 2, idealRange: 6, maxRange: 12, burstMin: 1, burstMax: 1, pauseMin: 0.15, pauseMax: 0.45, pushes: true, holds: false },
  marksman: { weapon: 'm24', minRange: 25, idealRange: 50, maxRange: 120, burstMin: 1, burstMax: 1, pauseMin: 1.7, pauseMax: 2.8, pushes: false, holds: true },
  gunner: { weapon: 'm249', minRange: 12, idealRange: 32, maxRange: 80, burstMin: 10, burstMax: 18, pauseMin: 0.9, pauseMax: 1.6, pushes: false, holds: true },
};

const SPECIALISTS: readonly BotRole[] = ['rusher', 'marksman', 'gunner', 'breacher'];

/**
 * Roles for a squad of `count`: one marksman per six, one gunner per eight,
 * one breacher per seven, a quarter rushers and riflemen for the rest, with
 * the specialists spread through the order rather than bunched.
 */
export function assignRoles(count: number): BotRole[] {
  const left: Record<BotRole, number> = {
    rifleman: 0,
    rusher: Math.floor(count / 4),
    marksman: Math.floor(count / 6),
    gunner: Math.floor(count / 8),
    breacher: Math.floor(count / 7),
  };
  const specialists: BotRole[] = [];
  for (let added = true; added; ) {
    added = false;
    for (const role of SPECIALISTS) {
      if (left[role] <= 0) continue;
      left[role]--;
      specialists.push(role);
      added = true;
    }
  }
  const roles: BotRole[] = Array.from({ length: count }, () => 'rifleman');
  specialists.forEach((role, k) => {
    roles[1 + Math.floor((k * (count - 1)) / specialists.length)] = role;
  });
  return roles;
}

const NAMES: readonly string[] = [
  'Voss', 'Harlan', 'Reyes', 'Okafor', 'Lindqvist', 'Marek', 'Dunne', 'Sato', 'Brandt', 'Kessler', 'Ivers', 'Molina',
  'Thorne', 'Varga', 'Quill', 'Navarro', 'Strand', 'Petrov', 'Hale', 'Corbin', 'Ashby', 'Renner', 'Falk', 'Mercer',
];

export function botName(index: number): string {
  const name = NAMES[index % NAMES.length] ?? 'Soldier';
  const lap = Math.floor(index / NAMES.length);
  return lap === 0 ? name : `${name} ${lap + 1}`;
}
