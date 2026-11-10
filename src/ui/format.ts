import type { MatchMode } from '../game/contracts';

/** Lives per match. Mirrors the rules in `src/game/game.ts`, which does not publish them. */
const SKIRMISH_LIVES = 3;

/** Seconds as `m:ss`. */
export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

/** Share of projectiles that hit someone, as a whole percentage. Null before the first shot. */
export function accuracyPercent(hits: number, projectiles: number): number | null {
  if (projectiles <= 0) return null;
  return Math.min(100, Math.round((hits / projectiles) * 100));
}

/** Whole seconds left before a respawn; holds at 1 until the game puts the player back. */
export function respawnCountdown(diedAt: number, now: number, delay: number): number {
  return Math.max(1, Math.ceil(delay - (now - diedAt)));
}

/** The rules a match is played under: a co-op match uses Skirmish or Survival rules. */
export function rulesOf(config: { readonly mode: MatchMode; readonly rules?: 'skirmish' | 'survival' } | null): MatchMode {
  if (!config) return 'skirmish';
  return config.mode === 'coop' ? (config.rules ?? 'skirmish') : config.mode;
}

export function livesLeft(mode: MatchMode, deaths: number): number {
  const lives = mode === 'skirmish' ? SKIRMISH_LIVES : 1;
  return Math.max(0, lives - deaths);
}
