import { createPointerGrab, type PointerGrab } from '../platform/index';
import type { ControlPreset, ControlSettings } from './settings';

export type Action =
  | 'moveForward'
  | 'moveBack'
  | 'moveLeft'
  | 'moveRight'
  | 'sprint'
  | 'crouch'
  | 'jump'
  | 'fire'
  | 'aim'
  | 'reload'
  | 'holdBreath'
  | 'weaponNext'
  | 'weaponPrev'
  | 'slot1'
  | 'slot2'
  | 'slot3'
  | 'slot4'
  | 'slot5'
  | 'slot6'
  | 'slot7'
  | 'scores'
  | 'pause';

/**
 * Binding codes are `KeyboardEvent.code` values plus `Mouse0` (primary click),
 * `Mouse2` (secondary click, a two-finger click on a trackpad), `WheelUp` and
 * `WheelDown` (two-finger scroll on a trackpad).
 */
export type Bindings = Readonly<Record<Action, readonly string[]>>;

const SHARED: Pick<
  Bindings,
  | 'moveForward'
  | 'moveBack'
  | 'moveLeft'
  | 'moveRight'
  | 'sprint'
  | 'reload'
  | 'weaponNext'
  | 'weaponPrev'
  | 'slot1'
  | 'slot2'
  | 'slot3'
  | 'slot4'
  | 'slot5'
  | 'slot6'
  | 'slot7'
  | 'scores'
  | 'pause'
> = {
  moveForward: ['KeyW', 'ArrowUp'],
  moveBack: ['KeyS', 'ArrowDown'],
  moveLeft: ['KeyA', 'ArrowLeft'],
  moveRight: ['KeyD', 'ArrowRight'],
  sprint: ['ShiftLeft'],
  reload: ['KeyR'],
  weaponNext: ['WheelDown', 'BracketRight'],
  weaponPrev: ['WheelUp', 'BracketLeft'],
  slot1: ['Digit1'],
  slot2: ['Digit2'],
  slot3: ['Digit3'],
  slot4: ['Digit4'],
  slot5: ['Digit5'],
  slot6: ['Digit6'],
  slot7: ['Digit7'],
  scores: ['KeyE', 'Tab'],
  pause: ['Escape', 'KeyP'],
};

/**
 * Trackpad preset: click to fire and Space to jump, as on a mouse. Aiming
 * is a toggle on Q, because a two-finger click cannot be held while the same hand
 * moves the view.
 */
export const BINDING_PRESETS: Readonly<Record<ControlPreset, Bindings>> = {
  trackpad: {
    ...SHARED,
    fire: ['Mouse0'],
    aim: ['KeyQ', 'Mouse2'],
    jump: ['Space'],
    crouch: ['KeyC'],
    holdBreath: ['ShiftLeft'],
  },
  mouse: {
    ...SHARED,
    fire: ['Mouse0'],
    aim: ['Mouse2'],
    jump: ['Space'],
    crouch: ['KeyC', 'ControlLeft'],
    holdBreath: ['ShiftLeft'],
  },
};

const WHEEL_THRESHOLD = 50;
/** After a switch, wheel input is ignored until it has been quiet this long (swallows trackpad momentum). */
const WHEEL_QUIET_MS = 180;
/** Single pointer events larger than this are browser glitches, not hand movement. */
const LOOK_SPIKE_PX = 600;

export interface LookDelta {
  readonly dx: number;
  readonly dy: number;
}

/**
 * Keyboard, pointer-lock and wheel input mapped to game actions. Call
 * `endFrame()` once per frame after reading.
 */
export class Input {
  private readonly held = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly released = new Set<string>();
  private lookX = 0;
  private lookY = 0;
  private smoothX = 0;
  private smoothY = 0;
  private wheelAccum = 0;
  private wheelLastEvent = 0;
  private wheelBlocked = false;
  private lockListeners = new Set<(locked: boolean) => void>();
  private readonly abort = new AbortController();
  /** Pointer Lock. */
  private readonly grab: PointerGrab;

  constructor(
    element: HTMLElement,
    private readonly controls: () => ControlSettings,
  ) {
    const opts = { signal: this.abort.signal };
    window.addEventListener('keydown', this.onKeyDown, opts);
    window.addEventListener('keyup', this.onKeyUp, opts);
    window.addEventListener('blur', this.releaseAll, opts);
    document.addEventListener('visibilitychange', this.releaseAll, opts);
    document.addEventListener('mousemove', this.onMouseMove, opts);
    element.addEventListener('mousedown', this.onMouseDown, opts);
    window.addEventListener('mouseup', this.onMouseUp, opts);
    element.addEventListener('contextmenu', (e) => e.preventDefault(), opts);
    element.addEventListener('wheel', this.onWheel, { ...opts, passive: false });
    this.grab = createPointerGrab(element);
    this.grab.onChange(this.onLockChange);
  }

  get locked(): boolean {
    return this.grab.locked;
  }

  get bindings(): Bindings {
    return BINDING_PRESETS[this.controls().preset];
  }

  /** Must be called from a user gesture (click or key press). */
  async requestLock(): Promise<void> {
    if (this.locked) return;
    await this.grab.request({ raw: this.controls().rawInput });
  }

  exitLock(): void {
    this.grab.release();
  }

  onLock(listener: (locked: boolean) => void): () => void {
    this.lockListeners.add(listener);
    return () => this.lockListeners.delete(listener);
  }

  isDown(action: Action): boolean {
    return this.bindings[action].some((code) => this.held.has(code));
  }

  wasPressed(action: Action): boolean {
    return this.bindings[action].some((code) => this.pressed.has(code));
  }

  wasReleased(action: Action): boolean {
    return this.bindings[action].some((code) => this.released.has(code));
  }

  /** Pointer travel since the last call, in CSS pixels, after optional smoothing. */
  consumeLook(dt: number): LookDelta {
    const smoothing = this.controls().lookSmoothing;
    const rawX = this.lookX;
    const rawY = this.lookY;
    this.lookX = 0;
    this.lookY = 0;
    if (smoothing <= 0) return { dx: rawX, dy: rawY };
    // Spread each delta over a short window so coarse trackpad reports feel continuous.
    this.smoothX += rawX;
    this.smoothY += rawY;
    const window = 0.012 + smoothing * 0.06;
    const share = Math.min(1, dt / window);
    const dx = this.smoothX * share;
    const dy = this.smoothY * share;
    this.smoothX -= dx;
    this.smoothY -= dy;
    return { dx, dy };
  }

  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
    this.held.delete('WheelUp');
    this.held.delete('WheelDown');
  }

  dispose(): void {
    this.abort.abort();
    this.lockListeners.clear();
    this.grab.dispose();
  }

  private press(code: string): void {
    if (!this.held.has(code)) this.pressed.add(code);
    this.held.add(code);
  }

  private release(code: string): void {
    if (this.held.delete(code)) this.released.add(code);
  }

  private readonly releaseAll = (): void => {
    for (const code of [...this.held]) this.release(code);
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    if (isTyping(e.target)) return;
    if (this.locked && (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow'))) {
      e.preventDefault();
    }
    this.press(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.release(e.code);
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    if (Math.abs(e.movementX) > LOOK_SPIKE_PX || Math.abs(e.movementY) > LOOK_SPIKE_PX) return;
    this.lookX += e.movementX;
    this.lookY += e.movementY;
  };

  private readonly onMouseDown = (e: MouseEvent): void => {
    if (!this.locked) return;
    this.press(`Mouse${e.button}`);
  };

  private readonly onMouseUp = (e: MouseEvent): void => {
    this.release(`Mouse${e.button}`);
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (!this.locked) return;
    e.preventDefault();
    // Pinch gestures arrive as wheel events with ctrlKey set.
    if (e.ctrlKey) return;
    // A trackpad sends a stream of small deltas and then a momentum tail. Act
    // once per gesture, then wait for the stream to go quiet.
    const now = performance.now();
    const quiet = now - this.wheelLastEvent > WHEEL_QUIET_MS;
    this.wheelLastEvent = now;
    if (quiet) {
      this.wheelBlocked = false;
      this.wheelAccum = 0;
    }
    if (this.wheelBlocked) return;
    this.wheelAccum += e.deltaY;
    if (Math.abs(this.wheelAccum) < WHEEL_THRESHOLD) return;
    this.press(this.wheelAccum > 0 ? 'WheelDown' : 'WheelUp');
    this.wheelAccum = 0;
    this.wheelBlocked = true;
  };

  private readonly onLockChange = (locked: boolean): void => {
    if (!locked) this.releaseAll();
    for (const listener of [...this.lockListeners]) listener(locked);
  };
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}
