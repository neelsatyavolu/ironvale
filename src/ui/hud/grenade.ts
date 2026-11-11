import type { GameContext, MatchSnapshot } from '../../game/contracts';
import { flag, h, textSlot } from '../dom';
import { keyName } from '../keys';
import '../styles/hud-grenade.css';

export interface GrenadeIndicator {
  readonly element: HTMLElement;
  update(snapshot: MatchSnapshot): void;
}

/** What the hint says for each state of the grenade. Pure, so it can be tested. */
export function grenadeHint(count: number, aiming: boolean, key: string): string {
  if (aiming) return `Release ${key} to throw`;
  return count > 0 ? `Hold ${key}` : 'Used';
}

/** The grenade line under the ammunition: how many are left (1 or 0) and the key that throws it. */
export function createGrenadeIndicator(ctx: GameContext): GrenadeIndicator {
  const count = textSlot('span', 'iv-nade__count', '0');
  const hint = textSlot('span', 'iv-nade__hint');
  const element = h('div', 'iv-nade', h('span', 'iv-nade__label', 'Grenade'), count.element, hint.element);
  const setOut = flag((on) => element.classList.toggle('is-out', on));
  const setAiming = flag((on) => element.classList.toggle('is-aiming', on));

  return {
    element,
    update(snapshot: MatchSnapshot): void {
      const code = ctx.input.bindings.grenade[0] ?? '';
      const key = keyName(code, ctx.settings.value.controls.preset);
      count.set(String(snapshot.grenades));
      hint.set(grenadeHint(snapshot.grenades, snapshot.grenadeAiming, key));
      setOut(snapshot.grenades === 0);
      setAiming(snapshot.grenadeAiming);
    },
  };
}
