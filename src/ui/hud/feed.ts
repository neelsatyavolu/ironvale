import type { KillFeedEntry } from '../../game/contracts';
import { h } from '../dom';
import { feedKey, trimKillFeed } from '../killfeed';

const MAX_ROWS = 4;
const MAX_AGE = 6;

export interface FeedView {
  readonly element: HTMLElement;
  update(entries: readonly KillFeedEntry[], now: number): void;
}

/**
 * The kill feed. Rows are rebuilt only when the set of kills on screen
 * changes, and rows already showing keep their element so they do not
 * re-animate.
 */
export function createFeed(localName: () => string, weaponName: (id: string) => string): FeedView {
  const element = h('ol', 'iv-feed');
  const rows = new Map<string, HTMLElement>();
  let signature = '';

  const who = (name: string): string => (name === localName() ? 'You' : name);

  function build(entry: KillFeedEntry): HTMLElement {
    return h(
      'li',
      'iv-feed__row',
      h('span', 'iv-feed__name', who(entry.killer)),
      h('span', 'iv-feed__weapon', entry.headshot ? `${weaponName(entry.weapon)}, headshot` : weaponName(entry.weapon)),
      h('span', 'iv-feed__name', who(entry.victim)),
    );
  }

  return {
    element,
    update(entries: readonly KillFeedEntry[], now: number): void {
      const visible = trimKillFeed(entries, now, MAX_AGE, MAX_ROWS);
      const keys = visible.map(feedKey);
      const next = keys.join('\n');
      if (next === signature) return;
      signature = next;
      for (const [key, row] of rows) {
        if (keys.includes(key)) continue;
        row.remove();
        rows.delete(key);
      }
      visible.forEach((entry, index) => {
        const key = keys[index] ?? '';
        if (rows.has(key)) return;
        const row = build(entry);
        rows.set(key, row);
        element.append(row);
      });
    },
  };
}
