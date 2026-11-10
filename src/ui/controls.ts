import { h, setAttrs } from './dom';
import './styles/controls.css';

export interface Option<T> {
  readonly value: T;
  readonly label: string;
}

export interface Control<T> {
  readonly element: HTMLElement;
  set(value: T): void;
}

export function button(label: string, variant: 'accent' | 'primary' | 'ghost', onPress: () => void): HTMLButtonElement {
  const element = h('button', `iv-btn iv-btn--${variant}`, label);
  setAttrs(element, { type: 'button', 'data-nav': '' });
  element.addEventListener('click', onPress);
  return element;
}

/**
 * A row of mutually exclusive choices. `value` may be something that matches
 * no option (a custom graphics preset), in which case none is marked.
 */
export function segmented<T>(
  label: string,
  options: readonly Option<T>[],
  onChange: (value: T) => void,
): Control<T | null> {
  const element = setAttrs(h('div', 'iv-seg'), { role: 'radiogroup', 'aria-label': label });
  const buttons = options.map((option) => {
    const item = setAttrs(h('button', 'iv-seg__item', option.label), {
      type: 'button',
      role: 'radio',
      'aria-checked': 'false',
      'data-nav': '',
    });
    item.addEventListener('click', () => onChange(option.value));
    element.append(item);
    return item;
  });
  let current: T | null | undefined;
  return {
    element,
    set(value: T | null): void {
      if (value === current) return;
      current = value;
      options.forEach((option, index) => {
        buttons[index]?.setAttribute('aria-checked', String(option.value === value));
      });
    },
  };
}

export function toggle(label: string, onChange: (value: boolean) => void): Control<boolean> {
  const state = h('span', 'iv-toggle__state', 'Off');
  const element = setAttrs(h('button', 'iv-toggle', state, h('span', 'iv-toggle__box')), {
    type: 'button',
    role: 'switch',
    'aria-checked': 'false',
    'aria-label': label,
    'data-nav': '',
  });
  let current = false;
  element.addEventListener('click', () => onChange(!current));
  return {
    element,
    set(value: boolean): void {
      if (value === current) return;
      current = value;
      element.setAttribute('aria-checked', String(value));
      state.textContent = value ? 'On' : 'Off';
    },
  };
}

export interface SliderSpec {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** How the value reads beside the track. */
  readonly format: (value: number) => string;
}

export function slider(spec: SliderSpec, onChange: (value: number) => void): Control<number> {
  const input = setAttrs(h('input', 'iv-slider__input'), {
    type: 'range',
    min: String(spec.min),
    max: String(spec.max),
    step: String(spec.step),
    'aria-label': spec.label,
    'data-nav': '',
  });
  const readout = h('span', 'iv-slider__value');
  const element = h('div', 'iv-slider', input, readout);
  const paint = (value: number): void => {
    const share = (value - spec.min) / (spec.max - spec.min);
    input.style.setProperty('--fill', `${(Math.min(1, Math.max(0, share)) * 100).toFixed(1)}%`);
    readout.textContent = spec.format(value);
  };
  input.addEventListener('input', () => {
    const value = Number(input.value);
    paint(value);
    onChange(value);
  });
  let current = Number.NaN;
  return {
    element,
    set(value: number): void {
      if (value === current) return;
      current = value;
      // Leave the thumb alone while the player is dragging it to the same place.
      if (Number(input.value) !== value) input.value = String(value);
      paint(value);
    },
  };
}

/** A settings row: name and optional note on the left, the control on the right. */
export function row(label: string, control: HTMLElement, note?: string): HTMLElement {
  const text = h('div', 'iv-row__text', h('span', 'iv-row__label', label), note ? h('span', 'iv-row__note', note) : null);
  return h('div', 'iv-row', text, control);
}

/** A group opened by a rule that carries a label and, optionally, a live value on the right. */
export function section(label: string, ...children: (HTMLElement | null)[]): { element: HTMLElement; meta: HTMLElement } {
  const meta = h('span', 'iv-rule__meta');
  const element = h('section', 'iv-section', h('header', 'iv-rule', h('span', 'iv-rule__label', label), meta), ...children);
  return { element, meta };
}
