/** Small pure pieces of the two-player rules. */

import type { Team } from '../game/contracts';
import type { NetRole } from './api';
import type { DuelBot } from './events';

export interface GroundPoint {
  readonly x: number;
  readonly z: number;
}

/** Index of the spawn furthest from the opponent, or -1 when there are none. */
export function pickDuelSpawn(spawns: readonly GroundPoint[], opponent: GroundPoint): number {
  let best = -1;
  let bestDistance = -1;
  spawns.forEach((spawn, index) => {
    const distance = Math.hypot(spawn.x - opponent.x, spawn.z - opponent.z);
    if (distance > bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

/** A duel ends when either player reaches the kill target. */
export function duelResult(kills: number, deaths: number, killTarget: number): 'won' | 'lost' | null {
  if (kills >= killTarget) return 'won';
  if (deaths >= killTarget) return 'lost';
  return null;
}

/**
 * Team and uniform of a duel bot on one machine. Each machine plays its own player as alpha,
 * so the bot is alpha where its owner is the local player. It wears its owner's uniform,
 * which is the same on both machines: the host's alpha, the guest's bravo.
 */
export function duelBotSide(owner: Exclude<DuelBot, 'none'>, role: NetRole): { team: Team; uniform: Team } {
  return { team: owner === role ? 'alpha' : 'bravo', uniform: owner === 'host' ? 'alpha' : 'bravo' };
}

/** Bots this machine runs in a duel: the host runs the one bot, whichever player it fights for. */
export function duelBotsHere(duelBot: DuelBot, role: NetRole): number {
  return duelBot !== 'none' && role === 'host' ? 1 : 0;
}
