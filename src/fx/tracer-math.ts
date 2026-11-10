/** Fastest a tracer is drawn travelling, in m/s. Real rounds cover 15 m a frame and cannot be followed. */
export const MAX_VISIBLE_SPEED = 340;
export const MIN_VISIBLE_SPEED = 55;
/** A tracer stays in flight at least this long so close shots still read. */
const MIN_TRAVEL_SECONDS = 0.075;
const STREAK_SECONDS = 0.018;
const MIN_STREAK = 0.8;
const MAX_STREAK = 7;
const MAX_PATH_FRACTION = 0.6;
const LOCAL_TRACER_EVERY = 3;
const PELLET_TRACER_EVERY = 4;

/** Speed the streak is drawn at for a shot that travels `distance` metres. */
export function visibleTracerSpeed(muzzleVelocity: number, distance: number): number {
  return Math.min(muzzleVelocity, MAX_VISIBLE_SPEED, Math.max(MIN_VISIBLE_SPEED, distance / MIN_TRAVEL_SECONDS));
}

/** Length of the streak in metres. */
export function tracerLength(speed: number, distance: number): number {
  const streak = Math.min(MAX_STREAK, Math.max(MIN_STREAK, speed * STREAK_SECONDS));
  return Math.min(streak, distance * MAX_PATH_FRACTION);
}

/** Whether the local player's `index`-th projectile shows a tracer. Bots always show theirs. */
export function showLocalTracer(index: number, pellets: number): boolean {
  return pellets > 1 ? index % PELLET_TRACER_EVERY === 1 : index % LOCAL_TRACER_EVERY === 0;
}
