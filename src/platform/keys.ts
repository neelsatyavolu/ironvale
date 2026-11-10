/**
 * WKWebView plays the system alert sound for every key press the page leaves
 * unhandled. In the Mac app the page claims those keys; this decides which.
 */

export interface KeyLike {
  readonly code: string;
  readonly metaKey: boolean;
}

/** Keys whose default action matters in menus: moving focus, pressing a button, scrolling, moving a slider. */
const MENU_KEYS: ReadonlySet<string> = new Set([
  'Tab',
  'Enter',
  'NumpadEnter',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
]);

export function suppressesKeyDefault(
  event: KeyLike,
  state: { readonly playing: boolean; readonly typing: boolean },
): boolean {
  if (state.typing) return false;
  // Command shortcuts belong to the menu bar.
  if (event.metaKey) return false;
  if (state.playing) return true;
  return !MENU_KEYS.has(event.code);
}
