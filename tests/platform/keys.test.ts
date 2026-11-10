import { describe, expect, it } from 'vitest';
import { suppressesKeyDefault, type KeyLike } from '../../src/platform/keys';

const press = (code: string, extra: Partial<KeyLike> = {}): KeyLike => ({ code, metaKey: false, ...extra });

describe('suppressesKeyDefault', () => {
  it('swallows every unhandled key while playing, so the system does not beep', () => {
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'Tab', 'Escape', 'Digit1', 'Digit7', 'ShiftLeft', 'KeyR', 'F5']) {
      expect(suppressesKeyDefault(press(code), { playing: true, typing: false })).toBe(true);
    }
  });

  it('leaves menu shortcuts to the app', () => {
    expect(suppressesKeyDefault(press('KeyQ', { metaKey: true }), { playing: true, typing: false })).toBe(false);
    expect(suppressesKeyDefault(press('KeyF', { metaKey: true }), { playing: false, typing: false })).toBe(false);
  });

  it('never gets in the way of typing', () => {
    expect(suppressesKeyDefault(press('KeyW'), { playing: false, typing: true })).toBe(false);
    expect(suppressesKeyDefault(press('KeyW'), { playing: true, typing: true })).toBe(false);
  });

  it('keeps focus movement, activation and scrolling in menus', () => {
    for (const code of ['Tab', 'Enter', 'NumpadEnter', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']) {
      expect(suppressesKeyDefault(press(code), { playing: false, typing: false })).toBe(false);
    }
  });

  it('swallows keys that do nothing in menus', () => {
    for (const code of ['KeyW', 'Digit3', 'Escape', 'Backquote', 'F11']) {
      expect(suppressesKeyDefault(press(code), { playing: false, typing: false })).toBe(true);
    }
  });
});
