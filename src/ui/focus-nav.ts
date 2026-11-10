export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** How much being off to the side counts against a candidate that is otherwise in line. */
const SIDE_WEIGHT = 0.3;
const EPSILON = 0.5;

/**
 * Index of the box to move to from `current` in `direction`, or -1 when
 * there is none. Boxes that overlap the current one across the direction of
 * travel (same row for left and right, same column for up and down) win over
 * ones that are merely closer.
 */
export function pickNeighbour(boxes: readonly Box[], current: number, direction: Direction): number {
  const from = boxes[current];
  if (!from) return -1;
  const horizontal = direction === 'left' || direction === 'right';
  const forward = direction === 'right' || direction === 'down';
  // Work in one frame: "main" is the axis of travel, "side" is across it.
  const main = (box: Box): readonly [number, number] => (horizontal ? [box.left, box.width] : [box.top, box.height]);
  const side = (box: Box): readonly [number, number] => (horizontal ? [box.top, box.height] : [box.left, box.width]);
  const [fromMain, fromMainSize] = main(from);
  const [fromSide, fromSideSize] = side(from);
  const fromCentre = fromMain + fromMainSize / 2;

  let best = -1;
  let bestInLine = false;
  let bestScore = Infinity;
  boxes.forEach((box, index) => {
    if (index === current) return;
    const [boxMain, boxMainSize] = main(box);
    const centre = boxMain + boxMainSize / 2;
    if (forward ? centre <= fromCentre + EPSILON : centre >= fromCentre - EPSILON) return;
    const gap = Math.max(0, forward ? boxMain - (fromMain + fromMainSize) : fromMain - (boxMain + boxMainSize));
    const [boxSide, boxSideSize] = side(box);
    const inLine = boxSide < fromSide + fromSideSize - EPSILON && boxSide + boxSideSize > fromSide + EPSILON;
    const offset = Math.abs(boxSide + boxSideSize / 2 - (fromSide + fromSideSize / 2));
    const score = gap + offset * SIDE_WEIGHT;
    if ((inLine && !bestInLine) || (inLine === bestInLine && score < bestScore)) {
      best = index;
      bestInLine = inLine;
      bestScore = score;
    }
  });
  return best;
}

const ARROWS: Readonly<Record<string, Direction>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

function navItems(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[data-nav]')].filter(
    (item) => !item.hasAttribute('disabled') && item.getClientRects().length > 0,
  );
}

/** Focus the element a screen marks with `data-nav-default`, or its first control. */
export function focusDefault(root: HTMLElement): void {
  const items = navItems(root);
  const target = items.find((item) => item.hasAttribute('data-nav-default')) ?? items[0];
  target?.focus({ preventScroll: true });
}

/**
 * Arrow-key movement between the `[data-nav]` controls inside `root`.
 * Returns true when the key was used. Sliders keep left and right for
 * themselves.
 */
export function handleArrowKey(root: HTMLElement, event: KeyboardEvent): boolean {
  const direction = ARROWS[event.key];
  if (!direction) return false;
  const active = document.activeElement;
  const isRange = active instanceof HTMLInputElement && active.type === 'range';
  if (isRange && (direction === 'left' || direction === 'right')) return false;
  event.preventDefault();
  const items = navItems(root);
  const current = active instanceof HTMLElement ? items.indexOf(active) : -1;
  if (current < 0) {
    focusDefault(root);
    return true;
  }
  const next = pickNeighbour(
    items.map((item) => item.getBoundingClientRect()),
    current,
    direction,
  );
  const target = items[next];
  if (target) {
    target.focus();
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  return true;
}
