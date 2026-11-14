import { time } from 'three/tsl';

/**
 * true under the ?freeze developer switch: everything animated for looks holds
 * at time 0 so two captures of the same pose match pixel for pixel. Read where
 * a visual clock advances; gameplay and networking never read it.
 */
export let visualsFrozen = false;

/** Turns the freeze on for the rest of the page's life. */
export function freezeVisuals(): void {
  visualsFrozen = true;
  // Three's shared shader clock (water, ground, film grain) reads frame time each render.
  time.onRenderUpdate(() => 0);
}
