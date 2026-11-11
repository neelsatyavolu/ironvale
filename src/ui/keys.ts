import type { Action, Bindings } from '../core/input';
import type { ControlPreset } from '../core/settings';

const SPECIAL: Readonly<Record<string, string>> = {
  Space: 'Space',
  Escape: 'Esc',
  Enter: 'Enter',
  Tab: 'Tab',
  Backquote: '`',
  ShiftLeft: 'Shift',
  ShiftRight: 'Right Shift',
  ControlLeft: 'Control',
  ControlRight: 'Right Control',
  AltLeft: 'Option',
  AltRight: 'Right Option',
  MetaLeft: 'Command',
  MetaRight: 'Right Command',
  ArrowUp: 'Up arrow',
  ArrowDown: 'Down arrow',
  ArrowLeft: 'Left arrow',
  ArrowRight: 'Right arrow',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Minus: '-',
  Equal: '=',
};

const POINTER: Readonly<Record<ControlPreset, Readonly<Record<string, string>>>> = {
  trackpad: {
    Mouse0: 'Click',
    Mouse1: 'Middle click',
    Mouse2: 'Two-finger click',
    WheelUp: 'Two-finger scroll up',
    WheelDown: 'Two-finger scroll down',
  },
  mouse: {
    Mouse0: 'Left click',
    Mouse1: 'Middle click',
    Mouse2: 'Right click',
    WheelUp: 'Scroll up',
    WheelDown: 'Scroll down',
  },
};

/** A name a player would recognise for a binding code (`KeyboardEvent.code`, `Mouse0`, `WheelUp`...). */
export function keyName(code: string, preset: ControlPreset): string {
  const pointer = POINTER[preset][code];
  if (pointer) return pointer;
  const special = SPECIAL[code];
  if (special) return special;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Numpad ${code.slice(6)}`;
  return code;
}

export interface BindingRow {
  readonly label: string;
  /** Alternatives, each one enough on its own. */
  readonly keys: readonly string[];
}

const MOVE: readonly Action[] = ['moveForward', 'moveLeft', 'moveBack', 'moveRight'];
const SLOTS: readonly Action[] = ['slot1', 'slot2', 'slot3', 'slot4'];

/** Single actions in the order the reference shows them. `scores` (E or Tab) holds the weapon picker open. */
const SINGLE: readonly (readonly [Action, string])[] = [
  ['sprint', 'Sprint'],
  ['jump', 'Jump'],
  ['crouch', 'Crouch'],
  ['fire', 'Fire'],
  ['aim', 'Aim'],
  ['reload', 'Reload'],
  ['grenade', 'Grenade (hold to aim, release to throw)'],
  ['holdBreath', 'Hold breath'],
  ['weaponNext', 'Next weapon'],
  ['weaponPrev', 'Previous weapon'],
  ['scores', 'Choose a weapon (hold)'],
];

function moveKeys(bindings: Bindings, preset: ControlPreset): readonly string[] {
  const sets = Math.max(...MOVE.map((action) => bindings[action].length));
  const keys: string[] = [];
  for (let index = 0; index < sets; index++) {
    const codes = MOVE.map((action) => bindings[action][index]).filter((code): code is string => code !== undefined);
    if (codes.length === 0) continue;
    if (codes.length === MOVE.length && codes.every((code) => code.startsWith('Arrow'))) keys.push('Arrow keys');
    else keys.push(codes.map((code) => keyName(code, preset)).join(' '));
  }
  return keys;
}

function slotKeys(bindings: Bindings, preset: ControlPreset): readonly string[] {
  const names = SLOTS.map((action) => bindings[action][0]).filter((code): code is string => code !== undefined);
  const digits = names.map((code) => (/^Digit\d$/.test(code) ? Number(code.slice(5)) : Number.NaN));
  const consecutive = digits.length > 1 && digits.every((digit, index) => digit === (digits[0] ?? 0) + index);
  if (consecutive) return [`${digits[0]} to ${digits[digits.length - 1]}`];
  return [names.map((code) => keyName(code, preset)).join(' ')];
}

/** The rows of the controls reference, read from the live bindings. */
export function bindingRows(bindings: Bindings, preset: ControlPreset): readonly BindingRow[] {
  const named = (action: Action): readonly string[] => bindings[action].map((code) => keyName(code, preset));
  return [
    { label: 'Move', keys: moveKeys(bindings, preset) },
    ...SINGLE.map(([action, label]) => ({ label, keys: named(action) })),
    { label: 'Choose weapon', keys: slotKeys(bindings, preset) },
    { label: 'Pause', keys: named('pause') },
  ];
}
