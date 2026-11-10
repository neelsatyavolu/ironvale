import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserPointerGrab, type LockDocument, type LockElement } from '../../src/platform/pointer';

afterEach(() => vi.restoreAllMocks());

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
