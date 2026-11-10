/**
 * Where the game is running: a browser tab or the Mac app (Tauri, WKWebView).
 * `Input` asks here for its pointer capture. In the Mac app this also starts
 * the app shell (bundled fonts, key handling), which the browser never loads.
 */
import { BrowserPointerGrab, NativePointerGrab, pickPointerBackend, type PointerGrab } from './pointer';
import { isTauri, tauriGrabBackend } from './tauri';

export type { PointerGrab } from './pointer';

export function createPointerGrab(element: HTMLElement): PointerGrab {
  const backend = pickPointerBackend({ tauri: isTauri(), userAgent: navigator.userAgent });
  if (backend === 'browser') return new BrowserPointerGrab(element, document);
  const grab = new NativePointerGrab(tauriGrabBackend(), window);
  import('./shell')
    .then((shell) => shell.installShell(grab))
    .catch((error: unknown) => console.warn('The app shell could not start', error));
  return grab;
}
