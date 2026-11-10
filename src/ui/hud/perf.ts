import type { GameContext } from '../../game/contracts';
import { textSlot } from '../dom';

const REFRESH_MS = 500;

export interface PerfReadout {
  readonly element: HTMLElement;
  toggle(): void;
  dispose(): void;
}

/** Frame time, render scale, renderer and, in a two-player match, round-trip time. Off until toggled; refreshes twice a second, not every frame. */
export function createPerf(ctx: GameContext, roundTripMs: () => number = () => -1): PerfReadout {
  const slot = textSlot('div', 'iv-perf');
  slot.element.hidden = true;
  let timer: ReturnType<typeof setInterval> | null = null;

  const refresh = (): void => {
    const { engine } = ctx;
    const ms = engine.frameTimeMs;
    const fps = ms > 0 ? Math.round(1000 / ms) : 0;
    const rtt = roundTripMs();
    slot.set(
      `${ms.toFixed(1)} ms  ${fps} fps  scale ${engine.renderScale.toFixed(2)}  ${engine.isWebGPU ? 'WebGPU' : 'WebGL 2'}${rtt >= 0 ? `  rtt ${rtt} ms` : ''}`,
    );
  };

  const stop = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  return {
    element: slot.element,
    toggle(): void {
      const show = slot.element.hidden;
      slot.element.hidden = !show;
      stop();
      if (!show) return;
      refresh();
      timer = setInterval(refresh, REFRESH_MS);
    },
    dispose: stop,
  };
}
