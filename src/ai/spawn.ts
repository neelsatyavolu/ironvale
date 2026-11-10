import type { Vector3 } from 'three/webgpu';
import type { SpawnPoint } from '../world/types';

export interface SpawnOrder {
  /** Spawn indices: those out of the player's view first, each group furthest first. */
  readonly indices: readonly number[];
  /** How many of `indices` are out of view. */
  readonly hidden: number;
}

/** Rank enemy spawns for a new wave. `inView` says whether the player can see spawn `index`. */
export function orderSpawns(spawns: readonly SpawnPoint[], player: Vector3, inView: (index: number) => boolean): SpawnOrder {
  const ranked = spawns.map((spawn, index) => ({
    index,
    seen: inView(index),
    distance: spawn.position.distanceTo(player),
  }));
  ranked.sort((a, b) => Number(a.seen) - Number(b.seen) || b.distance - a.distance);
  return { indices: ranked.map((entry) => entry.index), hidden: ranked.filter((entry) => !entry.seen).length };
}

/**
 * A spawn index for each of `count` soldiers. Hidden spawns are filled, up
 * to `capacity` each, before any spawn the player can see is used. A squad
 * larger than every slot doubles up rather than going unplaced.
 */
export function assignSpawns(count: number, order: SpawnOrder, capacity: number): number[] {
  const { indices, hidden } = order;
  if (indices.length === 0) return [];
  const picks: number[] = [];
  const fill = (from: number, to: number): void => {
    for (let lap = 0; lap < capacity && picks.length < count; lap++) {
      for (let i = from; i < to && picks.length < count; i++) picks.push(indices[i] ?? 0);
    }
  };
  fill(0, hidden);
  fill(hidden, indices.length);
  for (let i = 0; picks.length < count; i++) picks.push(indices[i % indices.length] ?? 0);
  return picks;
}

/** true when `point` lies within `halfAngle` of where the player faces, ignoring height (yaw 0 looks down -Z). */
export function inViewCone(player: Vector3, yaw: number, point: Vector3, halfAngle: number): boolean {
  const dx = point.x - player.x;
  const dz = point.z - player.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 1e-6) return true;
  return -Math.sin(yaw) * dx - Math.cos(yaw) * dz >= Math.cos(halfAngle) * distance;
}
