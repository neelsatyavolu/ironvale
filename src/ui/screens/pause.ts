import { button } from '../controls';
import { h, textSlot } from '../dom';
import '../styles/overlay.css';

export interface PauseActions {
  resume(): void;
  settings(): void;
  restart(): void;
  quit(): void;
}

export interface PauseScreen {
  readonly element: HTMLElement;
  /** One line under the title: map, mode and time. */
  setDetail(detail: string): void;
  /** A short message above the buttons, or an empty string to clear it. */
  setNote(note: string): void;
  /** true in a match with a friend: it keeps running behind this screen and cannot be restarted from here. */
  setLive(live: boolean): void;
}

export function createPause(actions: PauseActions): PauseScreen {
  const detail = textSlot('p', 'iv-label');
  const note = textSlot('p', 'iv-pause__note');
  note.element.setAttribute('role', 'status');
  const resume = button('Resume', 'primary', actions.resume);
  resume.setAttribute('data-nav-default', '');
  const title = textSlot('h2', 'iv-title', 'Paused');
  const restart = button('Restart', 'ghost', actions.restart);
  const quit = button('Quit to menu', 'ghost', actions.quit);

  const element = h(
    'div',
    'iv-screen iv-screen--scrim',
    h(
      'div',
      'iv-page iv-stack',
      h(
        'div',
        'iv-pause',
        title.element,
        detail.element,
        h('div', 'iv-pause__actions', resume, button('Settings', 'ghost', actions.settings), restart, quit),
        note.element,
      ),
    ),
  );

  return {
    element,
    setDetail: detail.set,
    setNote: note.set,
    setLive(live: boolean): void {
      title.set(live ? 'Match menu' : 'Paused');
      restart.hidden = live;
      quit.textContent = live ? 'Leave the match' : 'Quit to menu';
    },
  };
}
