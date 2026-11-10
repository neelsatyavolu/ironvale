/** Small pure pieces of the two-player rules. */

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
