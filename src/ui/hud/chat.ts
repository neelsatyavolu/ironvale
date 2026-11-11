import type { MatchSnapshot } from '../../game/contracts';
import type { ChatLine, NetLobby } from '../../net/api';
import { CHAT_LENGTH } from '../../net/limits';
import { h, setAttrs } from '../dom';
import '../styles/hud-chat.css';

const OPEN_KEY = 'KeyT';
/** Lines kept on screen, and how long each stays once nobody is typing. */
const MAX_LINES = 6;
const LINE_SECONDS = 10;

export interface Chat {
  readonly element: HTMLElement;
  update(snapshot: MatchSnapshot): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

/** Two-player chat: recent lines above the health readout, and a one-line box that T opens. */
export function createChat(net: Pick<NetLobby, 'sendChat' | 'onChat'>): Chat {
  const log = setAttrs(h('ol', 'iv-chat__log'), { 'aria-live': 'polite' });
  const input = setAttrs(h('input', 'iv-chat__input'), {
    type: 'text',
    maxlength: String(CHAT_LENGTH),
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'Message. Enter sends, Esc closes.',
    'aria-label': 'Chat message',
  });
  const hint = h('p', 'iv-chat__hint', 'T  Chat');
  const element = h('div', 'iv-chat', log, input, hint);
  input.hidden = true;
  element.hidden = true;

  /** A two-player match is on screen. */
  let enabled = false;
  let visible = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function close(): void {
    if (input.hidden) return;
    input.hidden = true;
    input.value = '';
    input.blur();
    hint.hidden = false;
  }

  function open(): void {
    input.hidden = false;
    hint.hidden = true;
    input.focus({ preventScroll: true });
  }

  function add(line: ChatLine): void {
    const row = h('li', line.mine ? 'iv-chat__line is-mine' : 'iv-chat__line', h('span', 'iv-chat__name', line.name), line.text);
    log.append(row);
    while (log.childElementCount > MAX_LINES) log.firstElementChild?.remove();
    const timer = setTimeout(() => {
      timers.delete(timer);
      row.remove();
    }, LINE_SECONDS * 1000);
    timers.add(timer);
  }

  const onKey = (event: KeyboardEvent): void => {
    if (!enabled || !visible) return;
    if (input.hidden) {
      if (event.code !== OPEN_KEY || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      // Keep the letter out of the box it is about to open.
      event.preventDefault();
      open();
    } else if (event.code === 'Enter' || event.code === 'NumpadEnter') {
      event.preventDefault();
      net.sendChat(input.value);
      close();
    } else if (event.code === 'Escape') {
      close();
    }
  };
  window.addEventListener('keydown', onKey);
  const offChat = net.onChat(add);

  return {
    element,
    update(snapshot: MatchSnapshot): void {
      const next = snapshot.net?.peerConnected === true;
      if (next === enabled) return;
      enabled = next;
      element.hidden = !enabled;
      if (!enabled) close();
    },
    setVisible(next: boolean): void {
      visible = next;
      if (!next) close();
    },
    dispose(): void {
      window.removeEventListener('keydown', onKey);
      offChat();
      for (const timer of timers) clearTimeout(timer);
    },
  };
}
