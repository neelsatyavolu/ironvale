import { BINDING_PRESETS } from '../../core/input';
import { CONTROL_PRESETS, type ControlPreset } from '../../core/settings';
import type { GameContext } from '../../game/contracts';
import { button, segmented } from '../controls';
import { h } from '../dom';
import { bindingRows } from '../keys';
import '../styles/sheet.css';

const SCHEME: Readonly<Record<ControlPreset, string>> = {
  trackpad:
    'On a trackpad your right hand only moves the view, so firing sits under your left thumb on Space and aiming is a toggle on Q. A click and a two-finger click still fire and aim if you prefer them, and a two-finger scroll changes weapon.',
  mouse:
    'The mouse preset is the usual layout: left click fires, right click aims while you hold it, and the wheel changes weapon.',
};

export interface ControlsScreen {
  readonly element: HTMLElement;
  dispose(): void;
}

/** The bindings for the preset in use, read from `BINDING_PRESETS`. */
export function createControlsReference(ctx: GameContext, actions: { close(): void }): ControlsScreen {
  const presetControl = segmented<ControlPreset>(
    'Control preset',
    [
      { value: 'trackpad', label: 'Trackpad' },
      { value: 'mouse', label: 'Mouse' },
    ],
    (preset) => ctx.settings.update('controls', CONTROL_PRESETS[preset]),
  );
  const scheme = h('p', 'iv-controls__scheme');
  const table = h('dl', 'iv-bindings');

  function render(preset: ControlPreset): void {
    presetControl.set(preset);
    scheme.textContent = SCHEME[preset];
    table.replaceChildren(
      ...bindingRows(BINDING_PRESETS[preset], preset).map((binding) => {
        const keys = h('dd', 'iv-bindings__keys');
        binding.keys.forEach((key, index) => {
          if (index > 0) keys.append(h('span', 'iv-bindings__or', 'or'));
          keys.append(h('span', '', key));
        });
        return h('div', 'iv-bindings__row', h('dt', '', binding.label), keys);
      }),
    );
  }

  const unsubscribe = ctx.settings.subscribe((next, previous) => {
    if (next.controls.preset !== previous.controls.preset) render(next.controls.preset);
  });
  render(ctx.settings.value.controls.preset);

  const back = button('Back', 'ghost', actions.close);
  back.setAttribute('data-nav-default', '');
  const element = h(
    'div',
    'iv-screen iv-sheet',
    h(
      'div',
      'iv-sheet__panel',
      h('header', 'iv-sheet__head', h('h2', 'iv-headline', 'Controls'), presetControl.element),
      h('div', 'iv-sheet__body iv-controls', scheme, table),
      h('footer', 'iv-sheet__foot', back, h('span', 'iv-keys', h('span', '', h('b', '', 'Esc'), ' back'))),
    ),
  );
  return { element, dispose: unsubscribe };
}
