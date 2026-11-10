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
