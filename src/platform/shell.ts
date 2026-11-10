/**
 * Mac app only: loaded by `createPointerGrab` when the page runs inside Tauri.
 * Brings the bundled fonts, keeps WKWebView from beeping on game keys, and
 * turns off the webview's own context menu.
 */
import './fonts.css';
import { suppressesKeyDefault } from './keys';
import type { PointerGrab } from './pointer';
import { FULLSCREEN_COMMAND, invokeApp } from './tauri';

let installed = false;

function isTyping(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement) return target.type !== 'range' && target.type !== 'checkbox';
  return target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
}

export function installShell(grab: PointerGrab): void {
  if (installed) return;
  installed = true;
  document.documentElement.dataset.platform = 'mac-app';

  // Registered after the game and the interface, so it runs last on `window`:
  // their handlers still see `defaultPrevented === false`.
  window.addEventListener('keydown', (event) => {
    if (event.code === 'F11' && !event.repeat) {
      invokeApp(FULLSCREEN_COMMAND).catch((error: unknown) => console.warn('Could not toggle full screen', error));
    }
    if (suppressesKeyDefault(event, { playing: grab.locked, typing: isTyping(event.target) })) event.preventDefault();
  });

  // The game draws under a transparent title bar; this invisible strip keeps the
  // window draggable by its top edge.
  const drag = document.createElement('div');
  drag.dataset.tauriDragRegion = '';
  drag.style.cssText = 'position:fixed;top:0;left:0;right:0;height:28px;z-index:2147483647';
  document.body.append(drag);

  // The webview's menu offers Reload and Back, which would drop the match.
  window.addEventListener('contextmenu', (event) => event.preventDefault());
}
