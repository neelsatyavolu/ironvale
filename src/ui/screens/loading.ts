import type { Bindings } from '../../core/input';
import type { ControlPreset } from '../../core/settings';
import type { MatchSnapshot } from '../../game/contracts';
import { h, reducedMotion, textSlot } from '../dom';
import { keyName } from '../keys';
import '../styles/overlay.css';

const TIP_SECONDS = 6;

/** Plain tips about the controls, written from the live bindings so they stay true. */
export function controlTips(bindings: Bindings, preset: ControlPreset): readonly string[] {
  const key = (code: string | undefined): string => (code ? keyName(code, preset) : '');
  const first = (codes: readonly string[]): string => key(codes[0]);
  const fire = first(bindings.fire);
  const aim = first(bindings.aim);
  const tips = [
    preset === 'trackpad'
      ? `${fire} fires, so your right hand can stay on the trackpad to look.`
      : `${fire} fires. Short bursts stay on target better than holding it down.`,
    preset === 'trackpad'
      ? `${aim} raises the sights. Press it again to lower them.`
      : `Hold ${aim.toLowerCase()} to aim. Shots spread less through the sights.`,
    preset === 'trackpad'
      ? `A two-finger scroll changes weapon. Keys ${first(bindings.slot1)} to ${first(bindings.slot4)} pick one directly.`
      : `The wheel changes weapon. Keys ${first(bindings.slot1)} to ${first(bindings.slot4)} pick one directly.`,
    `Hold ${first(bindings.sprint)} while moving forward to sprint. ${first(bindings.crouch)} crouches.`,
    `${first(bindings.reload)} reloads. Do it behind cover.`,
    `${first(bindings.jump)} jumps. ${first(bindings.pause)} pauses and frees the pointer.`,
  ];
  return tips;
}

export interface LoadingScreen {
  readonly element: HTMLElement;
  /** Start showing a map. */
  begin(map: { name: string; tagline: string }, detail: string, tips: readonly string[]): void;
  update(snapshot: MatchSnapshot): void;
  end(): void;
}

export function createLoading(): LoadingScreen {
  const name = textSlot('h2', 'iv-display');
  const tagline = textSlot('p', 'iv-lede');
  const detail = textSlot('span', 'iv-label');
  const label = textSlot('span', 'iv-loading__label');
  const percent = textSlot('span', 'iv-loading__percent', '0%');
  const fill = h('i', 'iv-loading__fill');
  const tip = textSlot('p', 'iv-loading__tip');

  const element = h(
    'div',
    'iv-screen iv-screen--solid iv-loading',
    h(
      'div',
      'iv-page',
      h('div', 'iv-loading__top', h('span', 'iv-label', 'Loading'), detail.element),
      h(
        'div',
        'iv-loading__main',
        name.element,
        tagline.element,
        h('div', 'iv-loading__rule', fill),
        h('div', 'iv-loading__status', label.element, percent.element),
      ),
      h('section', 'iv-loading__tips', h('header', 'iv-rule', h('span', 'iv-rule__label', 'Controls')), tip.element),
    ),
  );

  let tips: readonly string[] = [];
  let tipIndex = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastProgress = -1;

  const stop = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  const nextTip = (): void => {
    if (tips.length === 0) return;
    tipIndex = (tipIndex + 1) % tips.length;
    tip.set(tips[tipIndex] ?? '');
    if (!reducedMotion()) tip.element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'linear' });
  };

  return {
    element,
    begin(map, detailText, nextTips): void {
      name.set(map.name);
      tagline.set(map.tagline);
      detail.set(detailText);
      tips = nextTips;
      // Start somewhere new each load so a player sees them all over a few matches.
      tipIndex = Math.floor(Math.random() * Math.max(1, tips.length));
      tip.set(tips[tipIndex] ?? '');
      lastProgress = -1;
      stop();
      timer = setInterval(nextTip, TIP_SECONDS * 1000);
    },
    update(snapshot: MatchSnapshot): void {
      label.set(snapshot.loadingLabel);
      const progress = Math.min(1, Math.max(0, snapshot.loadingProgress));
      if (progress === lastProgress) return;
      lastProgress = progress;
      percent.set(`${Math.round(progress * 100)}%`);
      fill.style.transform = `scaleX(${progress.toFixed(3)})`;
    },
    end: stop,
  };
}
