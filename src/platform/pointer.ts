/**
 * Pointer capture for first-person look. The browser has Pointer Lock; the Mac
 * app's WKWebView refuses it, so the app freezes and hides the cursor natively
 * instead. Both keep `movementX` and `movementY` arriving on `mousemove`, so
 * the rest of the input code does not care which one is in use.
 */

export interface PointerGrabOptions {
  /** Ask for movement without OS pointer acceleration. Only the browser can honour it. */
  readonly raw: boolean;
}

export interface PointerGrab {
  /** The pointer is captured and its movement belongs to the game. */
  readonly locked: boolean;
  /** Must be called from a user gesture in the browser. Never rejects: a refusal is logged. */
  request(options: PointerGrabOptions): Promise<void>;
  release(): void;
  /** Fires on every change, whoever caused it. Returns the unsubscribe function. */
  onChange(listener: (locked: boolean) => void): () => void;
  dispose(): void;
}

export type PointerBackend = 'browser' | 'tauri-macos';

/** Windows WebView2 grants Pointer Lock by itself, so only the Mac app needs the native grab. */
export function pickPointerBackend(env: { readonly tauri: boolean; readonly userAgent: string }): PointerBackend {
  return env.tauri && /Macintosh|Mac OS X/.test(env.userAgent) ? 'tauri-macos' : 'browser';
}

type ChangeListener = (locked: boolean) => void;

/** The part of an element the browser path uses. */
export interface LockElement {
  requestPointerLock(options?: object): Promise<void> | void;
}

/** The part of the document the browser path uses. */
export interface LockDocument {
  readonly pointerLockElement: unknown;
  exitPointerLock(): void;
  addEventListener(type: 'pointerlockchange', listener: () => void): void;
  removeEventListener(type: 'pointerlockchange', listener: () => void): void;
}

/** The Pointer Lock API. */
export class BrowserPointerGrab implements PointerGrab {
  private readonly listeners = new Set<ChangeListener>();

  constructor(
    private readonly element: LockElement,
    private readonly doc: LockDocument,
  ) {
    doc.addEventListener('pointerlockchange', this.onLockChange);
  }

  get locked(): boolean {
    return this.doc.pointerLockElement === this.element;
  }

  async request(options: PointerGrabOptions): Promise<void> {
    if (this.locked) return;
    const request = this.element.requestPointerLock.bind(this.element);
    try {
      // Raw deltas skip OS pointer acceleration where the browser supports it.
      if (options.raw) await request({ unadjustedMovement: true });
      else await request();
    } catch {
      try {
        await request();
      } catch (error) {
        // Chrome refuses for about a second after the player presses Escape; the next click retries.
        console.warn('Pointer lock was refused', error);
      }
    }
  }

  release(): void {
    if (this.locked) this.doc.exitPointerLock();
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.doc.removeEventListener('pointerlockchange', this.onLockChange);
    this.listeners.clear();
  }

  private readonly onLockChange = (): void => {
    const locked = this.locked;
    for (const listener of [...this.listeners]) listener(locked);
  };
}

/** What the Mac app offers: freeze and hide the cursor, or give it back. */
export interface NativeGrabBackend {
  /** Resolves with the app's number for this grab. Numbers only go up. */
  grab(): Promise<number>;
  release(): Promise<void>;
  /**
   * The app let go by itself: the window lost focus, the app was deactivated or
   * the window closed. The listener gets the number of the grab that ended.
   */
  onReleased(listener: (grabId: number) => void): () => void;
}

/** Where the native path listens for Escape and blur. `window` in the app. */
export interface GrabEventTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

type NativeState = 'free' | 'grabbing' | 'grabbed';

/**
 * The Mac app's cursor grab, treated as a lock. Nothing releases it for us the
 * way a browser releases Pointer Lock, so Escape and a lost focus do it here.
 */
export class NativePointerGrab implements PointerGrab {
  private state: NativeState = 'free';
  private attempts = 0;
  /** The app's number for the grab held now. */
  private grabId = 0;
  /** The newest grab the app has reported dropping. A report can overtake the answer to `grab`. */
  private droppedId = 0;
  private readonly listeners = new Set<ChangeListener>();
  private readonly stopNative: () => void;

  constructor(
    private readonly backend: NativeGrabBackend,
    private readonly target: GrabEventTarget,
  ) {
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('blur', this.onBlur);
    this.stopNative = backend.onReleased(this.onNativeRelease);
  }

  get locked(): boolean {
    return this.state === 'grabbed';
  }

  async request(_options: PointerGrabOptions): Promise<void> {
    if (this.state !== 'free') return;
    this.state = 'grabbing';
    const attempt = ++this.attempts;
    let refusal: unknown = null;
    let grabId = 0;
    try {
      grabId = await this.backend.grab();
    } catch (error) {
      refusal = error ?? new Error('unknown');
    }
    // A newer request owns the state now.
    if (attempt !== this.attempts) return;
    if (this.state !== 'grabbing') {
      // Released while the grab was in flight: make sure the app really let go.
      if (refusal === null) this.letGo();
      return;
    }
    if (refusal !== null) {
      this.state = 'free';
      console.warn('The app could not capture the pointer', refusal);
      return;
    }
    if (grabId <= this.droppedId) {
      // The app took the grab and dropped it again before its answer got here.
      this.state = 'free';
      return;
    }
    this.grabId = grabId;
    this.state = 'grabbed';
    this.emit(true);
  }

  release(): void {
    if (this.state === 'free') return;
    const wasLocked = this.locked;
    this.state = 'free';
    this.letGo();
    // Told after the caller has finished, as the browser tells of an exited lock: a listener
    // must not run in the middle of the code that asked for the release.
    if (wasLocked) queueMicrotask(() => this.emit(false));
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('blur', this.onBlur);
    this.stopNative();
    this.listeners.clear();
    this.release();
  }

  private letGo(): void {
    this.backend.release().catch((error: unknown) => console.warn('The app could not release the pointer', error));
  }

  private emit(locked: boolean): void {
    for (const listener of [...this.listeners]) listener(locked);
  }

  private readonly onKeyDown = (event: Event): void => {
    if ((event as KeyboardEvent).code === 'Escape') this.release();
  };

  private readonly onBlur = (): void => this.release();

  private readonly onNativeRelease = (grabId: number): void => {
    this.droppedId = Math.max(this.droppedId, grabId);
    // A report about an earlier grab must not end the one held now.
    if (this.state !== 'grabbed' || grabId !== this.grabId) return;
    this.state = 'free';
    this.emit(false);
  };
}
