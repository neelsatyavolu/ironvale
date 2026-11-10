import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserPointerGrab,
  NativePointerGrab,
  pickPointerBackend,
  type LockDocument,
  type LockElement,
  type NativeGrabBackend,
} from '../../src/platform/pointer';

interface Deferred {
  resolve(): void;
  reject(error: Error): void;
}

/** A backend whose grab calls settle only when the test says so. Grabs are numbered from 1, as the app numbers them. */
function fakeBackend() {
  const grabs: Deferred[] = [];
  const calls: string[] = [];
  let released: ((grabId: number) => void) | null = null;
  let lastId = 0;
  const backend: NativeGrabBackend = {
    grab() {
      calls.push('grab');
      return new Promise<number>((resolve, reject) => grabs.push({ resolve: () => resolve(++lastId), reject }));
    },
    release() {
      calls.push('release');
      return Promise.resolve();
    },
    onReleased(listener) {
      released = listener;
      return () => {
        released = null;
      };
    },
  };
  return {
    backend,
    calls,
    grabs,
    /** The app let go by itself (window blur, app deactivate, window close). Defaults to the newest grab. */
    nativeRelease: (grabId = lastId) => released?.(grabId),
    hasNativeListener: () => released !== null,
  };
}

function key(code: string): Event {
  return Object.assign(new Event('keydown'), { code });
}

function setup() {
  const fake = fakeBackend();
  const target = new EventTarget();
  const grab = new NativePointerGrab(fake.backend, target);
  const changes: boolean[] = [];
  grab.onChange((locked) => changes.push(locked));
  return { ...fake, target, grab, changes };
}

async function grabbed() {
  const context = setup();
  const request = context.grab.request({ raw: false });
  context.grabs[0]!.resolve();
  await request;
  return context;
}

afterEach(() => vi.restoreAllMocks());

describe('NativePointerGrab', () => {
  it('starts free', () => {
    const { grab, calls } = setup();
    expect(grab.locked).toBe(false);
    expect(calls).toEqual([]);
  });

  it('locks once the app confirms the grab, and tells listeners', async () => {
    const { grab, grabs, changes, calls } = setup();
    const request = grab.request({ raw: true });
    expect(grab.locked).toBe(false);
    expect(changes).toEqual([]);
    grabs[0]!.resolve();
    await request;
    expect(grab.locked).toBe(true);
    expect(changes).toEqual([true]);
    expect(calls).toEqual(['grab']);
  });

  it('ignores a second request while one is in flight or held', async () => {
    const { grab, grabs, calls, changes } = setup();
    const first = grab.request({ raw: false });
    void grab.request({ raw: false });
    grabs[0]!.resolve();
    await first;
    await grab.request({ raw: false });
    expect(calls).toEqual(['grab']);
    expect(changes).toEqual([true]);
  });

  it('releases on request at once, and tells listeners after the caller has finished', async () => {
    const { grab, calls, changes } = await grabbed();
    grab.release();
    expect(grab.locked).toBe(false);
    expect(calls).toEqual(['grab', 'release']);
    // As with the browser's pointerlockchange: the game ends a match with exitLock() and then
    // changes phase, and its lock listener must see the new phase, not pause the ended match.
    expect(changes).toEqual([true]);
    await Promise.resolve();
    expect(changes).toEqual([true, false]);
  });

  it('does nothing when released while free', () => {
    const { grab, calls, changes } = setup();
    grab.release();
    expect(calls).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('releases on Escape, because no browser does it for the app', async () => {
    const { grab, target, changes, calls } = await grabbed();
    target.dispatchEvent(key('KeyW'));
    expect(grab.locked).toBe(true);
    target.dispatchEvent(key('Escape'));
    expect(grab.locked).toBe(false);
    await Promise.resolve();
    expect(changes).toEqual([true, false]);
    expect(calls).toEqual(['grab', 'release']);
  });

  it('releases when the window loses focus', async () => {
    const { grab, target, changes } = await grabbed();
    target.dispatchEvent(new Event('blur'));
    expect(grab.locked).toBe(false);
    await Promise.resolve();
    expect(changes).toEqual([true, false]);
  });

  it('follows a release the app made by itself without asking again', async () => {
    const { grab, nativeRelease, changes, calls } = await grabbed();
    nativeRelease();
    expect(grab.locked).toBe(false);
    expect(changes).toEqual([true, false]);
    expect(calls).toEqual(['grab']);
    nativeRelease();
    expect(changes).toEqual([true, false]);
  });

  it('ignores a late report about an earlier grab', async () => {
    const { grab, grabs, nativeRelease, changes } = await grabbed();
    grab.release();
    const again = grab.request({ raw: false });
    grabs[1]!.resolve();
    await again;
    // The app's report that grab 1 ended arrives only now; grab 2 is the one held.
    nativeRelease(1);
    expect(grab.locked).toBe(true);
    expect(changes).toEqual([true, false, true]);
    nativeRelease(2);
    expect(grab.locked).toBe(false);
    expect(changes).toEqual([true, false, true, false]);
  });

  it('stays free when the app dropped the grab before its answer arrived', async () => {
    const { grab, grabs, nativeRelease, changes, calls } = setup();
    const request = grab.request({ raw: false });
    // The window lost focus right after the app took the grab: the release report overtakes the answer.
    nativeRelease(1);
    grabs[0]!.resolve();
    await request;
    expect(grab.locked).toBe(false);
    expect(changes).toEqual([]);
    expect(calls).toEqual(['grab']);
    // And the next request starts cleanly.
    const again = grab.request({ raw: false });
    grabs[1]!.resolve();
    await again;
    expect(grab.locked).toBe(true);
  });

  it('lets go again if it was released while the grab was in flight', async () => {
    const { grab, grabs, changes, calls } = setup();
    const request = grab.request({ raw: false });
    grab.release();
    grabs[0]!.resolve();
    await request;
    expect(grab.locked).toBe(false);
    // Never locked, so listeners heard nothing; the app is told twice so it cannot stay grabbed.
    expect(changes).toEqual([]);
    expect(calls).toEqual(['grab', 'release', 'release']);
  });

  it('keeps a newer request when an older one settles late', async () => {
    const { grab, grabs, changes, calls } = setup();
    const first = grab.request({ raw: false });
    grab.release();
    const second = grab.request({ raw: false });
    grabs[0]!.resolve();
    await first;
    expect(calls).toEqual(['grab', 'release', 'grab']);
    grabs[1]!.resolve();
    await second;
    expect(grab.locked).toBe(true);
    expect(changes).toEqual([true]);
    expect(calls).toEqual(['grab', 'release', 'grab']);
  });

  it('stays free and warns when the app refuses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { grab, grabs, changes } = setup();
    const request = grab.request({ raw: false });
    grabs[0]!.reject(new Error('no window'));
    await expect(request).resolves.toBeUndefined();
    expect(grab.locked).toBe(false);
    expect(changes).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    // A later request is allowed.
    void grab.request({ raw: false });
    expect(grabs).toHaveLength(2);
  });

  it('can lock again after a release', async () => {
    const { grab, grabs, changes } = await grabbed();
    grab.release();
    const again = grab.request({ raw: false });
    grabs[1]!.resolve();
    await again;
    expect(changes).toEqual([true, false, true]);
  });

  it('stops telling a listener that unsubscribed', async () => {
    const { grab, grabs } = setup();
    const heard: boolean[] = [];
    const off = grab.onChange((locked) => heard.push(locked));
    off();
    const request = grab.request({ raw: false });
    grabs[0]!.resolve();
    await request;
    expect(heard).toEqual([]);
  });

  it('lets go and stops listening when disposed', async () => {
    const { grab, target, calls, changes, hasNativeListener } = await grabbed();
    grab.dispose();
    expect(calls).toEqual(['grab', 'release']);
    expect(grab.locked).toBe(false);
    expect(hasNativeListener()).toBe(false);
    target.dispatchEvent(key('Escape'));
    expect(calls).toEqual(['grab', 'release']);
    // Listeners are dropped before the release, like the browser path after dispose.
    expect(changes).toEqual([true]);
  });
});

/** The parts of the DOM the browser path touches. */
function fakeDom(outcomes: readonly ('ok' | 'refuse')[]) {
  const requests: (object | undefined)[] = [];
  const listeners = new Set<() => void>();
  let index = 0;
  const element: LockElement = {
    requestPointerLock(options?: object) {
      requests.push(options);
      const outcome = outcomes[index++] ?? 'ok';
      if (outcome === 'refuse') return Promise.reject(new Error('refused'));
      doc.pointerLockElement = element;
      for (const listener of [...listeners]) listener();
      return Promise.resolve();
    },
  };
  const doc: LockDocument & { pointerLockElement: unknown; exits: number } = {
    pointerLockElement: null,
    exits: 0,
    exitPointerLock() {
      doc.exits++;
      doc.pointerLockElement = null;
      for (const listener of [...listeners]) listener();
    },
    addEventListener: (_type: string, listener: () => void) => void listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => void listeners.delete(listener),
  };
  return { element, doc, requests, listeners };
}

describe('BrowserPointerGrab', () => {
  it('asks for raw movement when the player wants it', async () => {
    const { element, doc, requests } = fakeDom(['ok']);
    const grab = new BrowserPointerGrab(element, doc);
    const changes: boolean[] = [];
    grab.onChange((locked) => changes.push(locked));
    await grab.request({ raw: true });
    expect(requests).toEqual([{ unadjustedMovement: true }]);
    expect(grab.locked).toBe(true);
    expect(changes).toEqual([true]);
  });

  it('asks plainly when raw movement is off', async () => {
    const { element, doc, requests } = fakeDom(['ok']);
    const grab = new BrowserPointerGrab(element, doc);
    await grab.request({ raw: false });
    expect(requests).toEqual([undefined]);
  });

  it('falls back to a plain lock when raw movement is refused', async () => {
    const { element, doc, requests } = fakeDom(['refuse', 'ok']);
    const grab = new BrowserPointerGrab(element, doc);
    await grab.request({ raw: true });
    expect(requests).toEqual([{ unadjustedMovement: true }, undefined]);
    expect(grab.locked).toBe(true);
  });

  it('warns and stays free when the browser refuses twice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { element, doc } = fakeDom(['refuse', 'refuse']);
    const grab = new BrowserPointerGrab(element, doc);
    await expect(grab.request({ raw: false })).resolves.toBeUndefined();
    expect(grab.locked).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('does not ask again while locked', async () => {
    const { element, doc, requests } = fakeDom(['ok']);
    const grab = new BrowserPointerGrab(element, doc);
    await grab.request({ raw: false });
    await grab.request({ raw: false });
    expect(requests).toHaveLength(1);
  });

  it('exits the lock only when it holds it', async () => {
    const { element, doc } = fakeDom(['ok']);
    const grab = new BrowserPointerGrab(element, doc);
    grab.release();
    expect(doc.exits).toBe(0);
    await grab.request({ raw: false });
    grab.release();
    expect(doc.exits).toBe(1);
    expect(grab.locked).toBe(false);
  });

  it('reports a lock the browser dropped by itself (Escape)', async () => {
    const { element, doc } = fakeDom(['ok']);
    const grab = new BrowserPointerGrab(element, doc);
    const changes: boolean[] = [];
    grab.onChange((locked) => changes.push(locked));
    await grab.request({ raw: false });
    doc.exitPointerLock();
    expect(changes).toEqual([true, false]);
  });

  it('counts a lock on another element as not locked', () => {
    const { element, doc } = fakeDom([]);
    const grab = new BrowserPointerGrab(element, doc);
    doc.pointerLockElement = {};
    expect(grab.locked).toBe(false);
  });

  it('stops listening to the document when disposed', () => {
    const { element, doc, listeners } = fakeDom([]);
    const grab = new BrowserPointerGrab(element, doc);
    expect(listeners.size).toBe(1);
    grab.dispose();
    expect(listeners.size).toBe(0);
  });
});

describe('pickPointerBackend', () => {
  it('uses the browser lock on the web', () => {
    expect(pickPointerBackend({ tauri: false, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })).toBe('browser');
  });

  it('uses the native grab in the Mac app', () => {
    expect(pickPointerBackend({ tauri: true, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })).toBe('tauri-macos');
  });

  it('keeps the browser lock in a Tauri app on Windows, where the webview grants it', () => {
    expect(pickPointerBackend({ tauri: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe('browser');
  });
});
