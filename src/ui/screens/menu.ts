import type { Difficulty } from '../../core/settings';
import type { GameCommands, GameContext, MatchConfig, MatchMode } from '../../game/contracts';
import { button, section, segmented, slider } from '../controls';
import { h, readStored, setAttrs, writeStored } from '../dom';
import '../styles/menu.css';

type MenuMode = Extract<MatchMode, 'skirmish' | 'survival'>;

interface MenuChoices {
  readonly mapId: string;
  readonly mode: string;
  readonly botCount: number;
}

const STORAGE_KEY = 'ironvale.menu.v1';
const MIN_BOTS = 4;
const MAX_BOTS = 16;
const DEFAULT_BOTS = 8;
/** Enemies added per wave in Survival. Mirrors `src/game/game.ts`. */
const WAVE_GROWTH = 2;

const MODES: readonly { value: MenuMode; label: string; lives: string; note: string }[] = [
  { value: 'skirmish', label: 'Skirmish', lives: 'Three lives', note: 'Clear every enemy on the map before you run out of lives.' },
  { value: 'survival', label: 'Survival', lives: 'One life', note: 'Waves keep coming and each is larger than the last. See how long you hold.' },
];

const DIFFICULTIES: readonly { value: Difficulty; label: string; note: string }[] = [
  { value: 'recruit', label: 'Recruit', note: 'Slow to notice you and wide of the mark. Good for a first game.' },
  { value: 'regular', label: 'Regular', note: 'A fair fight. They aim steadily and use cover.' },
  { value: 'veteran', label: 'Veteran', note: 'Quick to react and accurate at range.' },
  { value: 'elite', label: 'Elite', note: 'They notice you in a quarter of a second. Stay out of the open.' },
];

export interface MenuActions {
  play(config: MatchConfig): void;
  openFriend(): void;
  openSettings(): void;
  openControls(): void;
  openCredits(): void;
}

export interface MenuScreen {
  readonly element: HTMLElement;
  /** Called each time the menu comes on screen. */
  shown(): void;
  setError(message: string): void;
  dispose(): void;
}

function thumbUrl(id: string): string {
  return `${import.meta.env.BASE_URL}assets/thumbs/${encodeURIComponent(id)}.jpg`;
}

export function createMenu(ctx: GameContext, commands: GameCommands, actions: MenuActions): MenuScreen {
  const maps = commands.listMaps();
  const stored = readStored<MenuChoices>(STORAGE_KEY, { mapId: maps[0]?.id ?? '', mode: 'skirmish', botCount: DEFAULT_BOTS });
  let choices: { mapId: string; mode: MenuMode; botCount: number } = {
    mapId: maps.some((map) => map.id === stored.mapId) ? stored.mapId : (maps[0]?.id ?? ''),
    mode: stored.mode === 'survival' ? 'survival' : 'skirmish',
    botCount: Math.min(MAX_BOTS, Math.max(MIN_BOTS, Math.round(stored.botCount))),
  };

  // Maps: one card per map with a thumbnail area that stays a flat block until an image loads.
  const mapList = setAttrs(h('div', 'iv-maps'), { role: 'radiogroup', 'aria-label': 'Map' });
  const mapCards = maps.map((map) => {
    const thumb = h('span', 'iv-map__thumb');
    const card = setAttrs(
      h(
        'button',
        'iv-map',
        thumb,
        h('span', 'iv-map__text', h('span', 'iv-map__name', map.name), h('span', 'iv-map__tagline', map.tagline)),
        h('span', 'iv-map__mark'),
      ),
      { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-nav': '' },
    );
    card.addEventListener('click', () => choose({ mapId: map.id }));
    mapList.append(card);
    return { id: map.id, card, thumb };
  });
  const mapSection = section('Map', mapList);
  mapSection.meta.textContent = `${maps.length} to choose from`;

  const modeControl = segmented(
    'Mode',
    MODES.map(({ value, label }) => ({ value, label })),
    (mode) => choose({ mode }),
  );
  modeControl.element.classList.add('iv-seg--wide');
  const modeNote = h('p', 'iv-note');
  const modeSection = section('Mode', modeControl.element, modeNote);

  const difficultyControl = segmented(
    'Difficulty',
    DIFFICULTIES.map(({ value, label }) => ({ value, label })),
    (difficulty) => ctx.settings.update('gameplay', { difficulty }),
  );
  difficultyControl.element.classList.add('iv-seg--wide');
  const difficultyNote = h('p', 'iv-note');
  const difficultySection = section('Difficulty', difficultyControl.element, difficultyNote);

  const countControl = slider(
    { label: 'Enemies', min: MIN_BOTS, max: MAX_BOTS, step: 1, format: (value) => String(value) },
    (botCount) => choose({ botCount }),
  );
  countControl.element.classList.add('iv-slider--wide');
  const countNote = h('p', 'iv-note');
  const countSection = section('Enemies', countControl.element, countNote);

  const playButton = button('Play', 'accent', () => {
    if (!choices.mapId) return;
    actions.play({
      mapId: choices.mapId,
      mode: choices.mode,
      difficulty: ctx.settings.value.gameplay.difficulty,
      botCount: choices.botCount,
    });
  });
  playButton.setAttribute('data-nav-default', '');
  playButton.classList.add('iv-btn--wide');

  const error = setAttrs(h('p', 'iv-menu__error'), { role: 'alert' });
  error.hidden = true;

  const element = h(
    'div',
    'iv-screen iv-screen--solid iv-menu',
    h(
      'div',
      'iv-page',
      h(
        'header',
        'iv-menu__head',
        h('h1', 'iv-display', 'Ironvale'),
        h('p', 'iv-lede', 'A first-person shooter against bots. Choose a map and set the terms.'),
      ),
      h(
        'div',
        'iv-menu__grid',
        mapSection.element,
        h('div', 'iv-menu__options', modeSection.element, difficultySection.element, countSection.element),
      ),
      h(
        'footer',
        'iv-menu__actions',
        playButton,
        button('Play with a friend', 'ghost', actions.openFriend),
        button('Settings', 'ghost', actions.openSettings),
        button('Controls', 'ghost', actions.openControls),
        button('Credits', 'ghost', actions.openCredits),
        error,
      ),
      h(
        'div',
        'iv-menu__foot',
        h('span', 'iv-keys', keyHint('Arrows', 'move'), keyHint('Enter', 'select'), keyHint('Esc', 'back')),
        h('span', 'iv-label', ctx.engine.isWebGPU ? 'WebGPU' : 'WebGL 2'),
      ),
    ),
  );

  function choose(patch: Partial<typeof choices>): void {
    choices = { ...choices, ...patch };
    writeStored(STORAGE_KEY, choices);
    render();
  }

  function render(): void {
    for (const { id, card } of mapCards) card.setAttribute('aria-checked', String(id === choices.mapId));
    const mode = MODES.find((item) => item.value === choices.mode) ?? MODES[0];
    modeControl.set(choices.mode);
    if (mode) {
      modeNote.textContent = mode.note;
      modeSection.meta.textContent = mode.lives;
    }
    const difficulty = ctx.settings.value.gameplay.difficulty;
    difficultyControl.set(difficulty);
    difficultyNote.textContent = DIFFICULTIES.find((item) => item.value === difficulty)?.note ?? '';
    countControl.set(choices.botCount);
    countNote.textContent =
      choices.mode === 'survival'
        ? `The first wave. Each wave after it adds ${WAVE_GROWTH} more.`
        : 'How many you have to clear to win.';
  }

  let thumbsRequested = false;
  function loadThumbs(): void {
    if (thumbsRequested) return;
    thumbsRequested = true;
    for (const { id, thumb } of mapCards) {
      const image = new Image();
      image.alt = '';
      image.decoding = 'async';
      image.addEventListener('load', () => thumb.append(image));
      // No thumbnail is fine: the flat block stays.
      image.src = thumbUrl(id);
    }
  }

  const unsubscribe = ctx.settings.subscribe((next, previous) => {
    if (next.gameplay.difficulty !== previous.gameplay.difficulty) render();
  });
  render();

  return {
    element,
    shown(): void {
      loadThumbs();
    },
    setError(message: string): void {
      error.textContent = message;
      error.hidden = message === '';
    },
    dispose: unsubscribe,
  };
}

function keyHint(key: string, action: string): HTMLElement {
  return h('span', '', h('b', '', key), ` ${action}`);
}
