import { flag, h } from '../dom';
import '../styles/scope.css';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Mil dots sit at these distances from the centre, as a share of the lens radius. */
const DOTS = [0.1, 0.2, 0.3, 0.4];
/** The fine wire thickens into a post beyond this share of the radius. */
const POST_START = 0.56;

function reticleMarkup(): string {
  const dots = DOTS.flatMap((d) => {
    const p = (d * 100).toFixed(1);
    return [`<circle cx="${p}" cy="0" r="0.75"/>`, `<circle cx="-${p}" cy="0" r="0.75"/>`, `<circle cx="0" cy="${p}" r="0.75"/>`, `<circle cx="0" cy="-${p}" r="0.75"/>`];
  }).join('');
  const post = (POST_START * 100).toFixed(1);
  return (
    `<path class="iv-scope__wire" d="M-100 0H100M0-100V100"/>` +
    `<path class="iv-scope__post" d="M-100 0H-${post}M${post} 0H100M0 ${post}V100"/>` +
    dots
  );
}

export interface ScopeOverlay {
  readonly element: HTMLElement;
  set(active: boolean): void;
}

/** Full-screen scope view: a black mask with a round clear lens, cross hairs with mil dots and a dark lens edge. */
export function createScope(): ScopeOverlay {
  const reticle = document.createElementNS(SVG_NS, 'svg');
  reticle.setAttribute('viewBox', '-100 -100 200 200');
  reticle.setAttribute('class', 'iv-scope__reticle');
  reticle.setAttribute('aria-hidden', 'true');
  reticle.innerHTML = reticleMarkup();
  const lens = h('div', 'iv-scope__lens', h('div', 'iv-scope__shade'));
  lens.append(reticle);
  const element = h('div', 'iv-scope', h('div', 'iv-scope__mask'), lens);
  element.hidden = true;
  return {
    element,
    set: flag((active) => {
      element.hidden = !active;
    }),
  };
}
