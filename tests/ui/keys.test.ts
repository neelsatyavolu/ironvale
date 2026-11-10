import { describe, expect, it } from 'vitest';
import { BINDING_PRESETS } from '../../src/core/input';
import { bindingRows, keyName } from '../../src/ui/keys';

describe('keyName', () => {
  it('names letters, digits and punctuation by their cap', () => {
    expect(keyName('KeyW', 'trackpad')).toBe('W');
    expect(keyName('Digit7', 'trackpad')).toBe('7');
    expect(keyName('BracketLeft', 'mouse')).toBe('[');
    expect(keyName('BracketRight', 'mouse')).toBe(']');
  });

  it('names special keys plainly', () => {
    expect(keyName('Space', 'trackpad')).toBe('Space');
    expect(keyName('Escape', 'trackpad')).toBe('Esc');
    expect(keyName('ShiftLeft', 'mouse')).toBe('Shift');
    expect(keyName('ControlLeft', 'mouse')).toBe('Control');
    expect(keyName('ArrowUp', 'mouse')).toBe('Up arrow');
    expect(keyName('Tab', 'mouse')).toBe('Tab');
  });

  it('describes pointer buttons and the wheel for the device in use', () => {
    expect(keyName('Mouse0', 'trackpad')).toBe('Click');
    expect(keyName('Mouse2', 'trackpad')).toBe('Two-finger click');
    expect(keyName('WheelDown', 'trackpad')).toBe('Two-finger scroll down');
    expect(keyName('Mouse0', 'mouse')).toBe('Left click');
    expect(keyName('Mouse2', 'mouse')).toBe('Right click');
    expect(keyName('WheelUp', 'mouse')).toBe('Scroll up');
  });

  it('falls back to the raw code for keys it does not know', () => {
    expect(keyName('F13', 'mouse')).toBe('F13');
  });
});

describe('bindingRows', () => {
  const find = (preset: 'trackpad' | 'mouse', label: string) =>
    bindingRows(BINDING_PRESETS[preset], preset).find((row) => row.label === label);

  it('folds the four move keys into one row', () => {
    expect(find('trackpad', 'Move')?.keys).toEqual(['W A S D', 'Arrow keys']);
  });

  it('folds the weapon slots into one range', () => {
    expect(find('mouse', 'Choose weapon')?.keys).toEqual(['1 to 7']);
  });

  it('lists every key bound to an action, in binding order', () => {
    expect(find('trackpad', 'Fire')?.keys).toEqual(['Click']);
    expect(find('trackpad', 'Aim')?.keys).toEqual(['Q', 'Two-finger click']);
    expect(find('trackpad', 'Jump')?.keys).toEqual(['Space']);
    expect(find('mouse', 'Jump')?.keys).toEqual(['Space']);
    expect(find('mouse', 'Crouch')?.keys).toEqual(['C', 'Control']);
    expect(find('mouse', 'Pause')?.keys).toEqual(['Esc', 'P']);
  });

  it('has no duplicate labels', () => {
    const labels = bindingRows(BINDING_PRESETS.trackpad, 'trackpad').map((row) => row.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
