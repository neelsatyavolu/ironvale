import type { Difficulty } from '../../core/settings';
import type { GameCommands, GameContext } from '../../game/contracts';
import type { LobbyState, NetErrorCode, NetMatchConfig, NetMethod } from '../../net/api';
import { button, section, segmented, slider } from '../controls';
import { h, setAttrs, textSlot } from '../dom';
import '../styles/friend.css';

const NAME_LENGTH = 16;
const MIN_BOTS = 4;
const MAX_BOTS = 16;
const MIN_KILLS = 3;
const MAX_KILLS = 30;
const COPIED_MS = 2000;

const DIFFICULTIES: readonly { value: Difficulty; label: string }[] = [
  { value: 'recruit', label: 'Recruit' },
  { value: 'regular', label: 'Regular' },
  { value: 'veteran', label: 'Veteran' },
  { value: 'elite', label: 'Elite' },
];

const MODE_NOTES: Readonly<Record<NetMatchConfig['mode'], string>> = {
  coop: 'The two of you against the enemy. The enemies run on the host\'s machine.',
  duel: 'One against one. Each kill is a point and you come back as far from your opponent as the map allows.',
};

const RULES_NOTES: Readonly<Record<NetMatchConfig['rules'], string>> = {
  skirmish: 'Three lives each. Clear every enemy to win.',
  survival: 'One life each per wave. Whoever falls comes back when the next wave starts.',
};

export interface FriendActions {
  close(): void;
  /** Run inside a click: starts audio and takes the pointer for the match about to load. */
  claimGesture(): void;
  /** Run inside a click: starts audio only. */
  claimAudio(): void;
}

export interface FriendScreen {
  readonly element: HTMLElement;
  /** Called each time the screen comes on screen. */
  open(): void;
  dispose(): void;
}

/** What went wrong and what to do next, in plain words. */
function errorText(error: NetErrorCode, state: LobbyState, wasHost: boolean): string {
  switch (error) {
    case 'signal-unreachable':
      return 'Could not reach the room service. Check your connection and try again, or use copy-and-paste codes instead.';
    case 'no-room':
      return 'No game is waiting under that code. Check it with your friend, or ask them to host again.';
    case 'room-full':
      return 'That game already has two players. Ask your friend to host again and send the new code.';
    case 'room-expired':
      return 'That code has expired. Host again to get a new one.';
    case 'rate-limited':
      return 'Too many attempts. Wait a minute, then try again.';
    case 'bad-code':
      return 'That is not a complete code. Copy the whole code and paste it again.';
    case 'wrong-code-kind':
      return wasHost
        ? 'That is an invite, not a reply. Paste the reply your friend sent back.'
        : 'That is a reply code. Paste the invite the host sent you.';
    case 'code-too-long':
      return 'That text is too long to be a code. Copy only the code and paste it again.';
    case 'connect-failed':
      return 'Could not connect to your friend. One of your networks may block direct connections. Try again, or try from another network.';
    case 'version':
      return 'You and your friend have different versions of the game. Both of you reload the page, then try again.';
    case 'unknown-map':
      return 'The host chose a map this copy of the game does not have. Both of you reload the page, then try again.';
    case 'load-failed':
      return 'The map could not be loaded. Check your connection, then host or join again.';
    case 'peer-left':
      return `${state.peerName} disconnected. Host or join again to play another match.`;
    case 'peer-timeout':
      return `The connection to ${state.peerName} was lost. Host or join again to play another match.`;
  }
}

function summaryRow(label: string): { element: HTMLElement; set(value: string): void } {
  const value = textSlot('span', 'iv-friend__value');
  return { element: h('div', 'iv-friend__fact', h('span', 'iv-label', label), value.element), set: value.set };
}

export function createFriend(ctx: GameContext, commands: GameCommands, actions: FriendActions): FriendScreen {
  const net = commands.net;
  const maps = commands.listMaps();
  const mapName = (id: string): string => maps.find((map) => map.id === id)?.name ?? id;
  /** null until the room service has been asked. */
  let roomsAvailable: boolean | null = null;
  let method: NetMethod = 'manual';
  /** Which role the last attempt was in, for wording an error after the session has reset. */
  let lastRole: 'host' | 'guest' = 'host';
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;

  // ---- name
  const nameInput = setAttrs(h('input', 'iv-input'), {
    type: 'text',
    maxlength: String(NAME_LENGTH),
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Your name',
    'data-nav': '',
  });
  nameInput.value = net.state.localName;
  nameInput.addEventListener('change', () => {
    net.setName(nameInput.value);
    nameInput.value = net.state.localName;
  });
  const nameSection = section('Your name', h('div', 'iv-friend__name', nameInput), h('p', 'iv-note', 'Your friend sees this. Up to 16 characters.'));

  // ---- idle: host or join
  const methodNote = h('p', 'iv-note');
  const hostButton = button('Host a game', 'accent', () => {
    lastRole = 'host';
    net.setName(nameInput.value);
    actions.claimAudio();
    net.host(method);
  });
  hostButton.setAttribute('data-nav-default', '');
  const hostSection = section('Host', h('p', 'iv-note', 'You choose the map and the rules, then give your friend a code.'), h('div', 'iv-friend__row', hostButton));

  const joinCode = setAttrs(h('input', 'iv-input iv-input--code'), {
    type: 'text',
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    maxlength: '12',
    placeholder: 'Room code',
    'aria-label': 'Room code',
    'data-nav': '',
  });
  const joinInvite = setAttrs(h('textarea', 'iv-input iv-input--block'), {
    rows: '3',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'Paste the invite from the host',
    'aria-label': 'Invite code',
    'data-nav': '',
  });
  const join = (): void => {
    lastRole = 'guest';
    net.setName(nameInput.value);
    actions.claimAudio();
    net.join(method, method === 'room' ? joinCode.value : joinInvite.value);
  };
  const joinButton = button('Join', 'primary', join);
  joinCode.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') join();
  });
  const joinNote = h('p', 'iv-note');
  const joinSection = section('Join', joinNote, h('div', 'iv-friend__row', joinCode, joinInvite, joinButton));

  const methodSwitch = button('', 'ghost', () => {
    method = method === 'room' ? 'manual' : 'room';
    render(net.state);
  });
  const backButton = button('Back', 'ghost', actions.close);
  const idleView = h(
    'div',
    'iv-friend__view',
    h('div', 'iv-friend__cols', hostSection.element, joinSection.element),
    methodNote,
    h('div', 'iv-friend__actions', backButton, methodSwitch),
  );

  // ---- connecting: codes going back and forth
  const linkStatus = setAttrs(h('p', 'iv-headline'), { role: 'status' });
  const codeLabel = textSlot('span', 'iv-rule__label');
  const codeBig = textSlot('p', 'iv-friend__room');
  const codeBlock = setAttrs(h('textarea', 'iv-input iv-input--block iv-input--well'), {
    rows: '4',
    readonly: '',
    spellcheck: 'false',
    'aria-label': 'Code to send',
  });
  const copyNote = textSlot('span', 'iv-label');
  const copyButton = button('Copy code', 'primary', () => {
    const code = net.state.code;
    const done = (text: string): void => {
      copyNote.set(text);
      if (copiedTimer !== null) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => copyNote.set(''), COPIED_MS);
    };
    const fallback = (): void => {
      // No clipboard access: select the code so one key press copies it.
      codeBlock.hidden = false;
      codeBlock.focus();
      codeBlock.select();
      done('Press Cmd+C or Ctrl+C to copy');
    };
    if (!navigator.clipboard) fallback();
    else navigator.clipboard.writeText(code).then(() => done('Copied'), fallback);
  });
  const codeSection = h(
    'section',
    'iv-section',
    h('header', 'iv-rule', codeLabel.element, copyNote.element),
    codeBig.element,
    codeBlock,
    h('div', 'iv-friend__row', copyButton),
  );

  const replyInput = setAttrs(h('textarea', 'iv-input iv-input--block'), {
    rows: '3',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'Paste the reply from your friend',
    'aria-label': 'Reply code',
    'data-nav': '',
  });
  const replyButton = button('Connect', 'accent', () => net.acceptReply(replyInput.value));
  const replySection = section('Reply from your friend', h('div', 'iv-friend__row', replyInput, replyButton));

  const cancelButton = button('Cancel', 'ghost', () => net.leave());
  // The host sets the match up while waiting; the panel moves here from the lobby and back.
  const linkSetup = h('div', 'iv-friend__slot');
  const lobbySetup = h('div', 'iv-friend__slot');
  const linkView = h('div', 'iv-friend__view', linkStatus, codeSection, replySection.element, linkSetup, h('div', 'iv-friend__actions', cancelButton));

  // ---- lobby: connected, setting the match up
  const lobbyStatus = setAttrs(h('p', 'iv-headline'), { role: 'status' });
  const linkQuality = textSlot('span', 'iv-label');
  const readyLine = setAttrs(h('p', 'iv-friend__ready'), { role: 'status' });

  const modeControl = segmented<NetMatchConfig['mode']>(
    'Mode',
    [
      { value: 'coop', label: 'Co-op' },
      { value: 'duel', label: 'Duel' },
    ],
    (mode) => net.setConfig({ mode }),
  );
  const modeNote = h('p', 'iv-note');
  const modeSection = section('Mode', modeControl.element, modeNote);
  const mapControl = segmented<string>(
    'Map',
    maps.map((map) => ({ value: map.id, label: map.name })),
    (mapId) => net.setConfig({ mapId }),
  );
  const mapSection = section('Map', mapControl.element);
  const rulesControl = segmented<NetMatchConfig['rules']>(
    'Rules',
    [
      { value: 'skirmish', label: 'Skirmish' },
      { value: 'survival', label: 'Survival' },
    ],
    (rules) => net.setConfig({ rules }),
  );
  const rulesNote = h('p', 'iv-note');
  const rulesSection = section('Rules', rulesControl.element, rulesNote);
  const difficultyControl = segmented<Difficulty>('Difficulty', DIFFICULTIES, (difficulty) => net.setConfig({ difficulty }));
  const difficultySection = section('Difficulty', difficultyControl.element);
  const countControl = slider({ label: 'Enemies', min: MIN_BOTS, max: MAX_BOTS, step: 1, format: String }, (botCount) => net.setConfig({ botCount }));
  const countSection = section('Enemies', countControl.element);
  const targetControl = slider(
    { label: 'Kills to win', min: MIN_KILLS, max: MAX_KILLS, step: 1, format: (value) => `First to ${value}` },
    (killTarget) => net.setConfig({ killTarget }),
  );
  const targetSection = section('Kills to win', targetControl.element);
  for (const control of [modeControl, mapControl, rulesControl, difficultyControl]) control.element.classList.add('iv-seg--wide');
  for (const control of [countControl, targetControl]) control.element.classList.add('iv-slider--wide');
  const setup = h(
    'div',
    'iv-friend__cols',
    h('div', 'iv-friend__stack', modeSection.element, mapSection.element),
    h('div', 'iv-friend__stack', rulesSection.element, difficultySection.element, countSection.element, targetSection.element),
  );

  // The guest sees the host's choices but cannot change them.
  const facts = {
    mode: summaryRow('Mode'),
    map: summaryRow('Map'),
    rules: summaryRow('Rules'),
    difficulty: summaryRow('Difficulty'),
    enemies: summaryRow('Enemies'),
    target: summaryRow('Kills to win'),
  };
  const summary = section('Set up by the host', h('div', 'iv-friend__facts', ...Object.values(facts).map((fact) => fact.element)));

  const startButton = button('Start match', 'accent', () => {
    actions.claimGesture();
    net.start();
  });
  const readyButton = button('Ready', 'accent', () => {
    actions.claimAudio();
    net.setReady(!net.state.localReady);
  });
  const leaveButton = button('Leave', 'ghost', () => net.leave());
  const lobbyView = h(
    'div',
    'iv-friend__view',
    h('div', 'iv-friend__status', lobbyStatus, linkQuality.element),
    lobbySetup,
    summary.element,
    readyLine,
    h('div', 'iv-friend__actions', startButton, readyButton, leaveButton),
  );

  const error = setAttrs(h('p', 'iv-menu__error iv-friend__error'), { role: 'alert' });
  const element = h(
    'div',
    'iv-screen iv-screen--solid iv-friend',
    h(
      'div',
      'iv-page',
      h(
        'header',
        'iv-friend__head',
        h('h2', 'iv-title', 'Play with a friend'),
        h('p', 'iv-lede', 'Two players, connected directly to each other. One hosts and shares a code; the other joins with it.'),
      ),
      nameSection.element,
      error,
      idleView,
      linkView,
      lobbyView,
    ),
  );

  function linkText(state: LobbyState): string {
    const manual = state.method === 'manual';
    switch (state.step) {
      case 'opening':
        if (state.role === 'host') return manual ? 'Preparing your invite. This takes a few seconds.' : 'Opening a room';
        return manual ? 'Reading the invite and preparing your reply' : 'Looking for the game';
      case 'waiting':
        return manual ? 'Send the invite to your friend, then paste the reply they send back.' : 'Waiting for your friend. The code works for ten minutes.';
      case 'reply':
        return 'Send this reply to the host. The game connects when they paste it.';
      default:
        return 'Connecting to your friend';
    }
  }

  function renderIdle(): void {
    const rooms = roomsAvailable === true;
    if (!rooms) method = 'manual';
    joinCode.hidden = method !== 'room';
    joinInvite.hidden = method !== 'manual';
    joinNote.textContent = method === 'room' ? 'Type the six-character code your friend gave you.' : 'Paste the invite your friend sent you. You will get a reply code to send back.';
    methodSwitch.hidden = !rooms;
    methodSwitch.textContent = method === 'room' ? 'Use copy-and-paste codes instead' : 'Use a room code instead';
    methodNote.textContent =
      method === 'room'
        ? 'The host gets a six-character room code to read out or send.'
        : rooms
          ? 'No server involved: the host sends an invite code by any messenger and the guest sends a reply code back.'
          : roomsAvailable === null
            ? 'Checking whether room codes are available.'
            : 'Room codes are not available here, so you pass two codes by hand: the host sends an invite by any messenger and the guest sends a reply back.';
  }

  function renderLink(state: LobbyState): void {
    linkStatus.textContent = linkText(state);
    const hasCode = state.code !== '';
    const room = state.method === 'room';
    codeSection.hidden = !hasCode;
    codeLabel.set(room ? 'Room code' : state.role === 'host' ? 'Invite code' : 'Reply code');
    codeBig.element.hidden = !room;
    codeBig.set(room ? state.code : '');
    codeBlock.hidden = room;
    if (codeBlock.value !== state.code) codeBlock.value = room ? '' : state.code;
    replySection.element.hidden = !(state.role === 'host' && state.method === 'manual' && state.step === 'waiting');
    linkSetup.hidden = state.role !== 'host';
    if (state.role === 'host') {
      if (setup.parentElement !== linkSetup) linkSetup.append(setup);
      renderSetup(state.config);
    }
  }

  function renderSetup(config: NetMatchConfig): void {
    const duel = config.mode === 'duel';
    modeControl.set(config.mode);
    modeNote.textContent = MODE_NOTES[config.mode];
    mapControl.set(config.mapId);
    rulesControl.set(config.rules);
    rulesNote.textContent = RULES_NOTES[config.rules];
    difficultyControl.set(config.difficulty);
    countControl.set(Math.min(MAX_BOTS, Math.max(MIN_BOTS, config.botCount)));
    targetControl.set(Math.min(MAX_KILLS, Math.max(MIN_KILLS, config.killTarget)));
    rulesSection.element.hidden = difficultySection.element.hidden = countSection.element.hidden = duel;
    targetSection.element.hidden = !duel;
  }

  function renderLobby(state: LobbyState): void {
    const host = state.role === 'host';
    const config = state.config;
    const duel = config.mode === 'duel';
    lobbyStatus.textContent = `Connected to ${state.peerName}`;
    linkQuality.set(state.rttMs >= 0 ? `Round trip ${state.rttMs} ms` : 'Measuring the connection');
    lobbySetup.hidden = !host;
    summary.element.hidden = host;
    startButton.hidden = !host;
    readyButton.hidden = host;
    if (host) {
      if (setup.parentElement !== lobbySetup) lobbySetup.append(setup);
      renderSetup(config);
      startButton.disabled = !state.peerReady;
      readyLine.textContent = state.peerReady ? `${state.peerName} is ready. Start when you are.` : `Waiting for ${state.peerName} to press Ready.`;
    } else {
      facts.mode.set(duel ? 'Duel' : 'Co-op');
      facts.map.set(mapName(config.mapId));
      facts.rules.set(config.rules === 'survival' ? 'Survival' : 'Skirmish');
      facts.difficulty.set(DIFFICULTIES.find((item) => item.value === config.difficulty)?.label ?? config.difficulty);
      facts.enemies.set(String(config.botCount));
      facts.target.set(`First to ${config.killTarget}`);
      facts.rules.element.hidden = facts.difficulty.element.hidden = facts.enemies.element.hidden = duel;
      facts.target.element.hidden = !duel;
      readyButton.textContent = state.localReady ? 'Not ready' : 'Ready';
      readyButton.classList.toggle('iv-btn--accent', !state.localReady);
      readyButton.classList.toggle('iv-btn--ghost', state.localReady);
      readyLine.textContent = state.localReady ? `You are ready. Waiting for ${state.peerName} to start the match.` : `Press Ready when you are set. ${state.peerName} starts the match.`;
    }
    readyLine.classList.toggle('is-ready', host ? state.peerReady : state.localReady);
  }

  function render(state: LobbyState): void {
    const view = state.step === 'idle' ? idleView : state.step === 'connected' ? lobbyView : linkView;
    const changed = view.hidden;
    for (const item of [idleView, linkView, lobbyView]) item.hidden = item !== view;
    if (state.role) lastRole = state.role;
    if (state.step === 'connected') {
      // The code has done its job; an old one left in the box would only confuse the next attempt.
      joinCode.value = '';
      joinInvite.value = '';
      replyInput.value = '';
    }
    nameInput.disabled = state.step !== 'idle' && state.step !== 'connected';
    error.textContent = state.error ? errorText(state.error, state, lastRole === 'host') : '';
    error.hidden = state.error === null;
    if (view === idleView) renderIdle();
    else if (view === linkView) renderLink(state);
    else renderLobby(state);
    // Keep the keyboard on the screen when the part with focus has just gone away.
    if (changed && !element.hidden) (view.querySelector<HTMLElement>('[data-nav-default], [data-nav]:not([disabled]):not([hidden])') ?? nameInput).focus({ preventScroll: true });
  }

  const unsubscribe = net.subscribe(render);
  render(net.state);

  return {
    element,
    open(): void {
      replyInput.value = '';
      void net.roomCodesAvailable().then((available) => {
        const first = roomsAvailable === null;
        roomsAvailable = available;
        // Room codes are the easier way: start there when they work.
        if (first && available) method = 'room';
        render(net.state);
      });
    },
    dispose(): void {
      unsubscribe();
      if (copiedTimer !== null) clearTimeout(copiedTimer);
    },
  };
}
