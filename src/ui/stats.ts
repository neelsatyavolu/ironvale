import type { GameContext } from '../game/contracts';
import { accuracyPercent } from './format';

export interface MatchStats {
  /** Whole percentage of the local player's projectiles that hit an enemy, or null before the first shot. */
  accuracy(): number | null;
  reset(): void;
  dispose(): void;
}

/** Counts the local player's shots and hits from the event bus; the match snapshot does not carry them. */
export function createStats(ctx: GameContext): MatchStats {
  let projectiles = 0;
  let hits = 0;
  const unsubscribe = [
    ctx.events.on('shotFired', (event) => {
      if (event.local) projectiles += Math.max(1, event.weapon.pellets);
    }),
    ctx.events.on('combatantHit', (event) => {
      if (event.attackerId === ctx.player.id && event.targetId !== ctx.player.id) hits++;
    }),
  ];
  return {
    accuracy: () => accuracyPercent(hits, projectiles),
    reset(): void {
      projectiles = 0;
      hits = 0;
    },
    dispose(): void {
      for (const off of unsubscribe) off();
    },
  };
}
