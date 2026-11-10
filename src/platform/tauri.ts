/**
 * The Mac app's side of the pointer grab: the commands and the event defined
 * in src-tauri/src/pointer.rs. The Tauri API is loaded on first use so the
 * browser build never fetches it.
 */
import type { NativeGrabBackend } from './pointer';

const GRAB_COMMAND = 'pointer_grab';
const RELEASE_COMMAND = 'pointer_release';
const RELEASED_EVENT = 'pointer-released';
export const FULLSCREEN_COMMAND = 'toggle_fullscreen';

/** Tauri injects this object into every page it loads. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function invokeApp<T = void>(command: string): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command);
}

export function tauriGrabBackend(): NativeGrabBackend {
  return {
    grab: () => invokeApp<number>(GRAB_COMMAND),
    release: () => invokeApp(RELEASE_COMMAND),
    onReleased(listener) {
      let stop: (() => void) | null = null;
      let stopped = false;
      import('@tauri-apps/api/event')
        .then(({ listen }) => listen<number>(RELEASED_EVENT, (event) => listener(event.payload)))
        .then((unlisten) => {
          if (stopped) unlisten();
          else stop = unlisten;
        })
        .catch((error: unknown) => console.warn('The app could not report pointer releases', error));
      return () => {
        stopped = true;
        stop?.();
      };
    },
  };
}
