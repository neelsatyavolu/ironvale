import { BINDING_PRESETS } from '../../core/input';
import { button } from '../controls';
import { h } from '../dom';
import { keyName } from '../keys';
import '../styles/overlay.css';

export interface FirstRunCard {
  readonly element: HTMLElement;
}

/** Shown once to trackpad players before their first match. */
export function createFirstRun(actions: { play(): void; useMouse(): void }): FirstRunCard {
  const bindings = BINDING_PRESETS.trackpad;
  const key = (codes: readonly string[]): string => keyName(codes[0] ?? '', 'trackpad');
  const rows: readonly (readonly [string, string])[] = [
    ['Move', 'W A S D'],
    ['Look', 'Trackpad'],
    ['Fire', `${key(bindings.fire)} or click`],
    ['Aim', key(bindings.aim)],
    ['Jump', key(bindings.jump)],
    ['Crouch', key(bindings.crouch)],
    ['Reload', key(bindings.reload)],
    ['Weapons', `${key(bindings.slot1)} to ${key(bindings.slot4)} or two-finger scroll`],
    ['Pause', key(bindings.pause)],
  ];
  const play = button('Play', 'accent', actions.play);
  play.setAttribute('data-nav-default', '');

  const element = h(
    'div',
    'iv-screen iv-screen--scrim iv-first',
    h(
      'div',
      'iv-first__card',
      h('h2', 'iv-headline', 'Playing on a trackpad'),
      h(
        'p',
        'iv-note',
        'Click to fire and press Q to raise the sights, so you never have to hold a two-finger click. You can change any of this in Settings.',
      ),
      h(
        'dl',
        'iv-first__keys',
        ...rows.map(([label, keys]) => h('div', 'iv-first__row', h('dt', '', label), h('dd', '', keys))),
      ),
      h('div', 'iv-first__actions', play, button('I use a mouse', 'ghost', actions.useMouse)),
    ),
  );
  return { element };
}
