import type { Difficulty } from '../core/settings';
import type { MatchConfig } from '../game/contracts';
import { WEAPON_IDS, type WeaponId } from './models/api';

/** Weapons handed out only on some difficulty levels. Anything not listed is always carried. */
const RESERVED: Readonly<Partial<Record<WeaponId, readonly Difficulty[]>>> = {
  m7: ['veteran', 'elite'],
};

/** Shown in the weapon picker beside a weapon the player does not carry this match. */
export const RESERVED_NOTE = 'Issued on Veteran and Elite only.';

/**
 * The weapons a player carries into a match, in slot order. A duel has no
 * difficulty level, so reserved weapons stay out of it.
 */
export function issuedWeapons(config: Pick<MatchConfig, 'mode' | 'difficulty'>): readonly WeaponId[] {
  return WEAPON_IDS.filter((id) => {
    const levels = RESERVED[id];
    return !levels || (config.mode !== 'duel' && levels.includes(config.difficulty));
  });
}
