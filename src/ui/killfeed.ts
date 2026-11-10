import type { KillFeedEntry } from '../game/contracts';

/** Entries newer than `maxAge` seconds, oldest first, capped to the newest `maxRows`. */
export function trimKillFeed(
  entries: readonly KillFeedEntry[],
  now: number,
  maxAge: number,
  maxRows: number,
): readonly KillFeedEntry[] {
  if (maxRows <= 0) return [];
  const fresh = entries.filter((entry) => now - entry.time < maxAge);
  return fresh.slice(-maxRows);
}

/** Identity of a kill, for telling new rows from ones already on screen. */
export function feedKey(entry: KillFeedEntry): string {
  return `${entry.time.toFixed(3)}|${entry.killer}|${entry.victim}`;
}
