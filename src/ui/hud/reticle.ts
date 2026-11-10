import type { GameContext } from '../../game/contracts';
import { damageAngle, unwrapAngle } from '../damage';
import { flag, h, reducedMotion } from '../dom';
import '../styles/reticle.css';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEG = 180 / Math.PI;
const ARC_COUNT = 3;
const ARC_SECONDS = 1.6;
/** Hits from within this angle of a showing arc refresh it instead of adding another. */
const ARC_MERGE = (25 * Math.PI) / 180;
const ARC_REDRAW = (0.5 * Math.PI) / 180;
const HIT_MS = 240;
const KILL_MS = 460;

function svg(viewBox: string, className: string, markup: string): SVGSVGElement {
  const element = document.createElementNS(SVG_NS, 'svg');
  element.setAttribute('viewBox', viewBox);
  element.setAttribute('class', className);
  element.setAttribute('aria-hidden', 'true');
  element.innerHTML = markup;
  return element;
}

interface Arc {
  readonly element: SVGSVGElement;
  dx: number;
  dz: number;
  /** Angle on screen, unwrapped so rotation never takes the long way. */
  shown: number;
  /** `performance.now()` when the arc has finished fading. */
  until: number;
  animation: Animation | null;
}

export interface Reticle {
  readonly element: HTMLElement;
  setCrosshair(visible: boolean): void;
  hit(fatal: boolean): void;
  /** `dx`, `dz`: direction from the player toward the source, in world space. */
  hurt(dx: number, dz: number): void;
  /** Re-aim the showing arcs after the player has turned. Cheap when none are showing. */
  track(): void;
  clear(): void;
}

/** Everything drawn at the centre of the view: crosshair, hit marker and the damage ring. */
export function createReticle(ctx: GameContext): Reticle {
  const crosshair = h('div', 'iv-cross', h('i'), h('i'), h('i'), h('i'));
  const marker = svg(
    '-16 -16 32 32',
    'iv-hitmark',
    '<path d="M-11-11L-5-5M11-11L5-5M-11 11L-5 5M11 11L5 5" />',
  );
  const ring = h('div', 'iv-hurt');
  const arcs: Arc[] = Array.from({ length: ARC_COUNT }, () => {
    // A 44 degree arc centred on the top of the ring.
    const element = svg('-50 -50 100 100', 'iv-hurt__arc', '<path d="M-18.0-44.5A48 48 0 0 1 18.0-44.5" />');
    ring.append(element);
    return { element, dx: 0, dz: 0, shown: 0, until: 0, animation: null };
  });
  const element = h('div', 'iv-reticle', ring, crosshair, marker);

  const showCrosshair = flag((on) => crosshair.classList.toggle('is-hidden', !on), true);
  let markerAnimation: Animation | null = null;

  function aim(arc: Arc, immediate: boolean): void {
    const target = damageAngle(arc.dx, arc.dz, ctx.player.yaw);
    const next = immediate ? target : unwrapAngle(arc.shown, target);
    if (!immediate && Math.abs(next - arc.shown) < ARC_REDRAW) return;
    arc.shown = next;
    arc.element.style.rotate = `${(next * DEG).toFixed(1)}deg`;
  }

  return {
    element,
    setCrosshair: showCrosshair,
    hit(fatal: boolean): void {
      markerAnimation?.cancel();
      marker.classList.toggle('is-kill', fatal);
      const still = reducedMotion();
      markerAnimation = marker.animate(
        [
          { opacity: 1, transform: still ? 'none' : 'scale(0.82)' },
          { opacity: 1, transform: 'none', offset: 0.3 },
          { opacity: 0, transform: still || !fatal ? 'none' : 'scale(1.12)' },
        ],
        { duration: fatal ? KILL_MS : HIT_MS, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
      );
    },
    hurt(dx: number, dz: number): void {
      const now = performance.now();
      const angle = damageAngle(dx, dz, ctx.player.yaw);
      const showing = arcs.find(
        (arc) => arc.until > now && Math.abs(unwrapAngle(angle, damageAngle(arc.dx, arc.dz, ctx.player.yaw)) - angle) < ARC_MERGE,
      );
      const arc = showing ?? arcs.reduce((oldest, candidate) => (candidate.until < oldest.until ? candidate : oldest));
      arc.dx = dx;
      arc.dz = dz;
      arc.until = now + ARC_SECONDS * 1000;
      aim(arc, !showing);
      arc.animation?.cancel();
      arc.animation = arc.element.animate([{ opacity: 1 }, { opacity: 1, offset: 0.35 }, { opacity: 0 }], {
        duration: ARC_SECONDS * 1000,
        easing: 'linear',
      });
    },
    track(): void {
      const now = performance.now();
      for (const arc of arcs) {
        if (arc.until > now) aim(arc, false);
      }
    },
    clear(): void {
      markerAnimation?.cancel();
      for (const arc of arcs) {
        arc.animation?.cancel();
        arc.until = 0;
      }
    },
  };
}
