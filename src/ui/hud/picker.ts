/**
 * Weapon picker: hold E (or Tab) for a panel in the middle of the screen with a side
 * view of each gun and what it is good at. 1 to 7, A and D, the arrow keys or a
 * scroll move the choice; letting go equips it. Playing alone, the game
 * stands still while it is open.
 */
import type { Action } from '../../core/input';
import type { GameContext, WeaponDef } from '../../game/contracts';
import { WEAPON_DEFS } from '../../weapons/defs';
import { h } from '../dom';
import '../styles/picker.css';

const SLOT_ACTIONS: readonly Action[] = ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7'];

const GOOD_AT: Readonly<Record<string, string>> = {
  m4a1: 'The all-rounder. Steady automatic fire that works from across a room to the far end of a lane.',
  m1garand: 'Two hits to the body at almost any range. Eight rounds, then a slow reload you should plan for.',
  mp5: 'Close quarters. Light, quick to raise and easy to control while moving; weak past 40 m.',
  r870: 'One shot inside a room. Nine pellets a shell, loaded one at a time. Little use beyond 25 m.',
  m24: 'Long sight lines. One shot to the head or chest drops anyone; slow bolt, and helpless up close.',
  m249: 'Holding a lane. A hundred rounds without reloading, but heavy, slow to aim and slow to reload.',
  m1911: 'A fast backup. Quickest gun to draw and aim, with seven hard-hitting rounds at short range.',
};

export interface Stat {
  readonly label: string;
  /** 0 to 1. */
  readonly value: number;
}

const unit = (value: number): number => Math.min(1, Math.max(0, value));

/** Four bars that compare the guns with each other. */
export function weaponStats(def: WeaponDef): readonly Stat[] {
  return [
    { label: 'Damage', value: unit((def.damage * def.pellets) / 135) },
    { label: 'Range', value: unit(def.falloffEnd / 500) ** 0.6 },
    { label: 'Rate of fire', value: unit(def.roundsPerMinute / 800) },
    { label: 'Handling', value: unit(1 - (def.aimTime - 0.14) / 0.34) * unit(def.mobility - 0.1) },
  ];
}

export interface Picker {
  readonly element: HTMLElement;
  /** Call once a frame, before the game clears input. */
  frame(): void;
}

export function createPicker(ctx: GameContext): Picker {
  const defs = Object.values(WEAPON_DEFS).sort((a, b) => a.slot - b.slot);
  const base = `${import.meta.env.BASE_URL}assets/weapons/`;

  const tabs = defs.map((def) =>
    h('li', 'iv-pick__tab', h('span', 'iv-pick__key', String(def.slot)), h('span', 'iv-pick__tabname', def.name)),
  );
  const picture = h('img', 'iv-pick__picture');
  picture.alt = '';
  picture.decoding = 'async';
  const name = h('h2', 'iv-pick__name');
  const kind = h('p', 'iv-pick__kind');
  const blurb = h('p', 'iv-pick__blurb');
  const ammo = h('p', 'iv-pick__ammo');
  const fills = [0, 1, 2, 3].map(() => h('i', 'iv-pick__fill'));
  const labels = [0, 1, 2, 3].map(() => h('span', 'iv-pick__statname'));
  const stats = h(
    'div',
    'iv-pick__stats',
    ...fills.map((fill, index) => h('div', 'iv-pick__stat', labels[index], h('span', 'iv-pick__bar', fill))),
  );
  const panel = h(
    'div',
    'iv-pick__panel',
    h('ol', 'iv-pick__tabs', ...tabs),
    h('div', 'iv-pick__body', h('div', 'iv-pick__art', picture), h('div', 'iv-pick__text', name, kind, blurb, stats, ammo)),
    h('p', 'iv-pick__hint', '1 to 7, A and D or scroll to choose. Let go of E to equip.'),
  );
  const element = h('div', 'iv-pick', panel);

  let open = false;
  let chosen = -1;

  function show(index: number): void {
    if (index === chosen) return;
    tabs[chosen]?.classList.remove('is-on');
    chosen = index;
    const def = defs[index]!;
    tabs[index]!.classList.add('is-on');
    picture.src = `${base}${def.id}.webp`;
    name.textContent = def.name;
    kind.textContent = `${def.fireMode === 'auto' ? 'Automatic' : def.fireMode === 'semi' ? 'Semi-automatic' : def.fireMode === 'bolt' ? 'Bolt action' : 'Pump action'} · ${def.magazineSize} rounds`;
    blurb.textContent = GOOD_AT[def.id] ?? '';
    weaponStats(def).forEach((stat, i) => {
      labels[i]!.textContent = stat.label;
      fills[i]!.style.transform = `scaleX(${stat.value.toFixed(2)})`;
    });
    const state = ctx.weapons.loadout.find((weapon) => weapon.def.id === def.id);
    ammo.textContent = state ? `${state.magazine} in the gun, ${state.reserve} spare` : '';
  }

  return {
    element,
    frame(): void {
      const held = ctx.input.isDown('scores') && ctx.player.alive;
      if (held && !open) {
        open = true;
        chosen = -1;
        show(Math.max(0, defs.findIndex((def) => def.id === ctx.weapons.current.def.id)));
        element.classList.add('is-on');
      } else if (!held && open) {
        open = false;
        element.classList.remove('is-on');
        const def = defs[chosen];
        if (def && def.id !== ctx.weapons.current.def.id) ctx.weapons.equip(def.slot);
      }
      if (!open) return;

      const input = ctx.input;
      let next = chosen;
      SLOT_ACTIONS.forEach((action, index) => {
        if (input.wasPressed(action)) next = index;
      });
      if (input.wasPressed('weaponNext') || input.wasPressed('moveRight')) next = (next + 1) % defs.length;
      if (input.wasPressed('weaponPrev') || input.wasPressed('moveLeft')) next = (next + defs.length - 1) % defs.length;
      show(next);
    },
  };
}
