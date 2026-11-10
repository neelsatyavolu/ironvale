/** Pointer capture for first-person look. `Input` asks here for it. */
import { BrowserPointerGrab, type PointerGrab } from './pointer';

export type { PointerGrab } from './pointer';

export function createPointerGrab(element: HTMLElement): PointerGrab {
  return new BrowserPointerGrab(element, document);
}
