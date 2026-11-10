import type { MatchMode } from '../../game/contracts';
import { button } from '../controls';
import { h, textSlot } from '../dom';
import { formatClock } from '../format';
import '../styles/overlay.css';

export interface MatchResult {
  readonly won: boolean;
  readonly mode: MatchMode;
  readonly mapName: string;
  readonly kills: number;
  readonly deaths: number;
  readonly elapsed: number;
  readonly wave: number;
  /** Whole percentage, or null when no shot was fired or the count is not known. */
  readonly accuracy: number | null;
  /** Co-op: the rules the pair played under. */
  readonly rules?: 'skirmish' | 'survival';
  /** Set when the match was played with a friend. */
  readonly friend?: {
    readonly name: string;
    readonly kills: number;
    readonly killTarget: number;
    /** Still connected, so the two can go back to the lobby together. */
    readonly connected: boolean;
  } | null;
}

export interface EndScreen {
  readonly element: HTMLElement;
  show(result: MatchResult): void;
}

export interface EndActions {
  again(): void;
  menu(): void;
  /** Two-player: back to the lobby with the friend still connected. */
  lobby(): void;
  /** Two-player: disconnect and go to the menu. */
  leave(): void;
}

function stat(label: string, lead = false): { element: HTMLElement; set(value: string, unit?: string): void; setLabel(label: string): void } {
  const value = textSlot('span', 'iv-stat__value');
  const unit = textSlot('span', 'iv-stat__unit');
  const name = textSlot('span', 'iv-stat__label', label);
  const element = h(
    'div',
    lead ? 'iv-stat iv-stat--lead' : 'iv-stat',
    name.element,
    h('span', 'iv-stat__figure', value.element, unit.element),
  );
  return {
    element,
    set(next: string, nextUnit = ''): void {
      value.set(next);
      unit.set(nextUnit);
    },
    setLabel: name.set,
  };
}

function headline(result: MatchResult): string {
  const friend = result.friend;
  if (result.mode === 'duel') {
    const name = friend?.name ?? 'Your friend';
    if (!friend?.connected) return `${name} disconnected`;
    return result.won ? 'You won the duel' : `${name} won the duel`;
  }
  const survival = (result.mode === 'coop' ? result.rules : result.mode) === 'survival';
  if (result.won) return `${result.mapName} is clear`;
  if (survival) return result.wave > 1 ? `You held for ${result.wave - 1} ${result.wave === 2 ? 'wave' : 'waves'}` : 'You fell in the first wave';
  return 'Out of lives';
}

function modeLine(result: MatchResult): string {
  if (result.mode === 'duel') return `Duel · first to ${result.friend?.killTarget ?? 10}`;
  const rules = (result.mode === 'coop' ? result.rules : result.mode) === 'survival' ? 'Survival' : 'Skirmish';
  return result.mode === 'coop' ? `Co-op · ${rules}` : rules;
}

export function createEnd(actions: EndActions): EndScreen {
  const title = textSlot('h2', 'iv-title');
  const detail = textSlot('p', 'iv-label');
  const kills = stat('Kills', true);
  const deaths = stat('Deaths');
  const time = stat('Time');
  const accuracy = stat('Accuracy');
  const partner = stat('Friend');
  /** Which pair of actions the two buttons carry out, set by `show`. */
  let together = false;
  const again = button('Play again', 'accent', () => (together ? actions.lobby() : actions.again()));
  again.setAttribute('data-nav-default', '');
  const menu = button('Menu', 'ghost', () => (together ? actions.leave() : actions.menu()));

  const element = h(
    'div',
    'iv-screen iv-screen--scrim',
    h(
      'div',
      'iv-page iv-stack',
      h(
        'div',
        'iv-end',
        title.element,
        detail.element,
        h('div', 'iv-end__stats', kills.element, deaths.element, partner.element, time.element, accuracy.element),
        h('div', 'iv-end__actions', again, menu),
      ),
    ),
  );

  return {
    element,
    show(result: MatchResult): void {
      title.set(headline(result));
      const friend = result.friend ?? null;
      const duel = result.mode === 'duel';
      detail.set(`${result.mapName} · ${modeLine(result)}`);
      // A duel's score is the two kill counts; co-op adds the friend's share beside your own.
      kills.setLabel(duel ? 'You' : 'Kills');
      kills.set(String(result.kills));
      deaths.element.hidden = duel;
      deaths.set(String(result.deaths));
      partner.element.hidden = friend === null;
      if (friend) {
        partner.setLabel(duel ? friend.name : `Kills, ${friend.name}`);
        partner.set(String(friend.kills));
      }
      together = friend?.connected === true;
      again.textContent = together ? 'Back to lobby' : 'Play again';
      // A duel cannot be replayed alone.
      again.hidden = duel && !together;
      menu.textContent = together ? 'Leave' : 'Menu';
      time.set(formatClock(result.elapsed));
      accuracy.element.hidden = result.accuracy === null;
      if (result.accuracy !== null) accuracy.set(String(result.accuracy), '%');
    },
  };
}
