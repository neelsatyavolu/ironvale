// Base styles first: the screens' own stylesheets build on them.
import './styles/base.css';
import { BINDING_PRESETS } from '../core/input';
import { CONTROL_PRESETS } from '../core/settings';
import type { GameCommands, GameContext, MatchConfig, MatchPhase, MatchSnapshot } from '../game/contracts';
import { h, readStored, writeStored } from './dom';
import { focusDefault, handleArrowKey } from './focus-nav';
import { formatClock, rulesOf } from './format';
import { createHud } from './hud/hud';
import { createControlsReference } from './screens/controls-ref';
import { createCredits } from './screens/credits';
import { createEnd } from './screens/end';
import { createFirstRun } from './screens/first-run';
import { JOIN_PARAM } from '../net/room-code';
import { createFriend } from './screens/friend';
import { controlTips, createLoading } from './screens/loading';
import { createMenu } from './screens/menu';
import { createPause } from './screens/pause';
import { createSettings } from './screens/settings';
import { createStats } from './stats';

export interface Interface {
  dispose(): void;
}

type ScreenId = 'menu' | 'loading' | 'pause' | 'end' | 'settings' | 'controls' | 'firstRun' | 'friend' | 'credits';
type Overlay = Extract<ScreenId, 'settings' | 'controls' | 'firstRun' | 'friend' | 'credits'>;

const FONTS_URL =
  'https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500&family=Geist:wght@400;500&family=Geist+Mono:wght@400;500&display=swap';
const FIRST_RUN_KEY = 'ironvale.firstRun.v1';
const PERF_KEY = 'Backquote';
/** How long after a refused pointer lock to wait before telling the player to click again. */
const LOCK_GRACE_MS = 200;
const MODE_NAMES: Readonly<Record<string, string>> = { skirmish: 'Skirmish', survival: 'Survival', coop: 'Co-op', duel: 'Duel' };
const DIFFICULTY_NAMES: Readonly<Record<string, string>> = {
  recruit: 'Recruit',
  regular: 'Regular',
  veteran: 'Veteran',
  elite: 'Elite',
};

/** Web fonts are a nicety: offline the system stacks in the CSS take over. */
function loadFonts(): HTMLLinkElement[] {
  const link = (rel: string, href: string, crossOrigin = false): HTMLLinkElement => {
    const element = document.createElement('link');
    element.rel = rel;
    element.href = href;
    if (crossOrigin) element.crossOrigin = 'anonymous';
    document.head.append(element);
    return element;
  };
  return [
    link('preconnect', 'https://fonts.googleapis.com'),
    link('preconnect', 'https://fonts.gstatic.com', true),
    link('stylesheet', FONTS_URL),
  ];
}

/** Menus, settings and the HUD, as a DOM layer above the canvas. */
export function createInterface(ctx: GameContext, commands: GameCommands): Interface {
  const fontLinks = loadFonts();
  const stats = createStats(ctx);
  const net = commands.net;
  const hud = createHud(ctx, () => (net.state.inMatch ? net.state.rttMs : -1), net);

  let phase: MatchPhase | null = null;
  let snapshot: MatchSnapshot | null = null;
  let overlay: Overlay | null = null;
  /** Where Back goes from the controls reference when it was opened from Settings. */
  let controlsReturn: Overlay | null = null;
  let shown: ScreenId | null | undefined;
  /** A match the menu started: only then does a missing pointer lock pause the game. */
  let startedHere = false;
  /** Resume is waiting for the pointer lock to engage. */
  let wantResume = false;
  let pendingConfig: MatchConfig | null = null;
  let lockTimer: ReturnType<typeof setTimeout> | null = null;

  const mapInfo = (id: string): { name: string; tagline: string } =>
    commands.listMaps().find((map) => map.id === id) ?? { name: id.charAt(0).toUpperCase() + id.slice(1), tagline: '' };

  /** Must run inside a click or key handler: browsers only grant the pointer and audio from a gesture. */
  function claimGesture(): Promise<void> {
    try {
      void ctx.audio.unlock().catch((error: unknown) => console.warn('Audio could not start', error));
    } catch (error) {
      console.warn('Audio could not start', error);
    }
    return ctx.input.requestLock();
  }

  /** One line under a title saying what is being played. */
  function modeDetail(config: MatchConfig): string {
    if (config.mode === 'duel') return `Duel · first to ${config.killTarget ?? 10}`;
    const rules = MODE_NAMES[rulesOf(config)] ?? config.mode;
    return config.mode === 'coop' ? `Co-op · ${rules}` : rules;
  }

  /** Leave a match with a friend (if there is one) and go to the menu. */
  function leaveMatch(): void {
    if (net.state.step !== 'idle') net.leave();
    commands.quitToMenu();
  }

  function report(error: unknown): void {
    const message = error instanceof Error ? error.message : 'Unknown error';
    menu.setError(`Could not start the match. ${message}`);
  }

  function start(config: MatchConfig): void {
    startedHere = true;
    overlay = null;
    void claimGesture();
    commands.startMatch(config).catch(report);
  }

  function restart(): void {
    startedHere = true;
    overlay = null;
    void claimGesture();
    commands.restart().catch(report);
  }

  function resume(): void {
    wantResume = true;
    pause.setNote('');
    if (lockTimer !== null) clearTimeout(lockTimer);
    const request = claimGesture();
    if (ctx.input.locked) {
      finishResume();
      return;
    }
    // Chrome refuses a new lock for about 1.25 s after Escape. Stay paused and say so.
    void request.then(() => {
      lockTimer = setTimeout(() => {
        lockTimer = null;
        if (!wantResume || ctx.input.locked || phase !== 'paused') return;
        wantResume = false;
        pause.setNote('Click again to resume');
      }, LOCK_GRACE_MS);
    });
  }

  function finishResume(): void {
    wantResume = false;
    commands.resume();
  }

  function open(next: Overlay | null): void {
    overlay = next;
    render();
  }

  const menu = createMenu(ctx, commands, {
    play(config): void {
      const firstRun = readStored(FIRST_RUN_KEY, { seen: false });
      if (ctx.settings.value.controls.preset === 'trackpad' && !firstRun.seen) {
        pendingConfig = config;
        open('firstRun');
        return;
      }
      start(config);
    },
    openFriend: () => open('friend'),
    openSettings: () => open('settings'),
    openControls(): void {
      controlsReturn = null;
      open('controls');
    },
    openCredits: () => open('credits'),
  });
  const loading = createLoading();
  const pause = createPause({
    resume,
    settings: () => open('settings'),
    restart,
    quit: leaveMatch,
  });
  const end = createEnd({
    again: restart,
    menu: () => commands.quitToMenu(),
    lobby(): void {
      commands.quitToMenu();
      open('friend');
    },
    leave: leaveMatch,
  });
  const friend = createFriend(ctx, commands, {
    close: () => open(null),
    claimGesture: () => void claimGesture(),
    claimAudio(): void {
      void ctx.audio.unlock().catch((error: unknown) => console.warn('Audio could not start', error));
    },
  });
  const settings = createSettings(ctx, {
    close: () => open(null),
    openControls(): void {
      controlsReturn = 'settings';
      open('controls');
    },
  });
  const controls = createControlsReference(ctx, { close: () => open(controlsReturn) });
  const credits = createCredits(ctx, { close: () => open(null) });
  const firstRun = createFirstRun({
    play: () => finishFirstRun(),
    useMouse(): void {
      ctx.settings.update('controls', CONTROL_PRESETS.mouse);
      finishFirstRun();
    },
  });

  function finishFirstRun(): void {
    writeStored(FIRST_RUN_KEY, { seen: true });
    const config = pendingConfig;
    pendingConfig = null;
    if (config) start(config);
    else open(null);
  }

  const screens: Readonly<Record<ScreenId, HTMLElement>> = {
    menu: menu.element,
    loading: loading.element,
    pause: pause.element,
    end: end.element,
    settings: settings.element,
    controls: controls.element,
    firstRun: firstRun.element,
    friend: friend.element,
    credits: credits.element,
  };
  for (const element of Object.values(screens)) element.hidden = true;
  const root = h('div', 'iv-root', hud.element, ...Object.values(screens));
  // ?ui=off hides the whole interface for clean screenshots of the scene.
  root.hidden = new URLSearchParams(location.search).get('ui') === 'off';
  document.body.append(root);
  // Opened from a friend's invite link: go straight to the join screen.
  if (new URLSearchParams(location.search).has(JOIN_PARAM)) overlay = 'friend';

  function activeScreen(): ScreenId | null {
    const canOverlay = phase === 'menu' || (phase === 'paused' && overlay !== 'friend' && overlay !== 'credits');
    if (overlay && canOverlay) return overlay;
    switch (phase) {
      case 'menu':
        return 'menu';
      case 'loading':
        return 'loading';
      case 'paused':
        return 'pause';
      case 'won':
      case 'lost':
        return 'end';
      default:
        return null;
    }
  }

  function render(): void {
    const next = activeScreen();
    if (next === shown) return;
    shown = next;
    for (const [id, element] of Object.entries(screens)) element.hidden = id !== next;
    if (!next) {
      // Nothing should keep keyboard focus while the game has the keys.
      if (document.activeElement instanceof HTMLElement && root.contains(document.activeElement)) document.activeElement.blur();
      return;
    }
    const overMenu = phase === 'menu';
    for (const sheet of [settings.element, controls.element, firstRun.element, credits.element]) {
      sheet.classList.toggle('iv-screen--solid', overMenu);
      sheet.classList.toggle('iv-screen--scrim', !overMenu);
    }
    if (next === 'settings') settings.open();
    if (next === 'friend') friend.open();
    focusDefault(screens[next]);
    // Thumbnails wait a tick so a scripted start (?autostart) never asks for them.
    if (next === 'menu') setTimeout(() => shown === 'menu' && menu.shown(), 0);
  }

  function enterPhase(previous: MatchPhase | null, next: MatchPhase, state: MatchSnapshot): void {
    const config = state.config;
    const map = mapInfo(config?.mapId ?? '');
    if (previous === 'loading') loading.end();
    if (next !== 'menu' && next !== 'paused') overlay = null;
    if (next !== 'paused') wantResume = false;

    if (next === 'loading' && config) {
      stats.reset();
      menu.setError('');
      const preset = ctx.settings.value.controls.preset;
      const detail =
        config.mode === 'duel'
          ? modeDetail(config)
          : `${modeDetail(config)} · ${DIFFICULTY_NAMES[config.difficulty] ?? config.difficulty} · ${config.botCount} enemies`;
      loading.begin(map, detail, controlTips(BINDING_PRESETS[preset], preset));
    } else if (next === 'playing' && previous === 'loading' && startedHere) {
      // The player let go of the pointer while the map loaded: wait for them on the pause screen.
      queueMicrotask(() => {
        if (phase !== 'playing' || ctx.input.locked) return;
        commands.pause();
        wantResume = true;
      });
    } else if (next === 'paused') {
      // P pauses without releasing the pointer; the menu needs it back.
      if (ctx.input.locked) ctx.input.exitLock();
      pause.setNote('');
      pause.setLive(net.state.inMatch);
      pause.setDetail(`${map.name} · ${config ? modeDetail(config) : ''} · ${formatClock(state.elapsed)}`);
    } else if ((next === 'won' || next === 'lost') && config) {
      end.show({
        won: next === 'won',
        mode: config.mode,
        mapName: map.name,
        kills: state.kills,
        deaths: state.deaths,
        elapsed: state.elapsed,
        wave: state.wave,
        accuracy: stats.accuracy(),
        rules: config.rules,
        friend: state.net
          ? { name: state.net.peerName, kills: state.net.peerKills, killTarget: state.net.killTarget, connected: state.net.peerConnected }
          : null,
      });
    } else if (next === 'menu') {
      startedHere = false;
      // The first arrival at the menu keeps an overlay opened by an invite link.
      if (previous !== null) overlay = null;
    }
  }

  function onSnapshot(state: MatchSnapshot): void {
    const previous = phase;
    snapshot = state;
    // A match with no enemies is "won" on its first frame. That is a developer
    // sandbox (?autostart&bots=0), not a result: keep showing the HUD.
    phase = state.phase === 'won' && state.config?.botCount === 0 && state.config.mode !== 'duel' ? 'playing' : state.phase;
    if (phase !== previous) enterPhase(previous, phase, state);
    // A handler above may have changed the phase again; the newer snapshot has already been drawn.
    if (snapshot !== state) return;
    const inMatch = phase === 'playing' || phase === 'paused';
    hud.setVisible(inMatch);
    if (inMatch) hud.update(state);
    if (phase === 'loading') loading.update(state);
    render();
  }

  function back(): void {
    if (overlay === 'controls') open(controlsReturn);
    else if (overlay === 'friend') {
      // Escape must not drop a connection by accident: Cancel and Leave do that.
      if (net.state.step === 'idle') open(null);
    } else if (overlay === 'firstRun') {
      pendingConfig = null;
      open(null);
    } else if (overlay) open(null);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.code === PERF_KEY && (phase === 'playing' || phase === 'paused')) {
      hud.togglePerf();
      return;
    }
    if (!shown) return;
    const screen = screens[shown];
    const typing = event.target instanceof HTMLInputElement ? event.target.type !== 'range' : event.target instanceof HTMLTextAreaElement;
    if (event.key === 'Escape') {
      event.preventDefault();
      // The first Escape leaves the text box; the next one goes back.
      if (typing) (event.target as HTMLElement).blur();
      else back();
      return;
    }
    // Arrow keys and Enter belong to the text box while the player is typing in it.
    if (typing) return;
    if (handleArrowKey(screen, event)) return;
    if (event.key === 'Enter' && !screen.contains(document.activeElement)) {
      // Nothing focused yet: Enter takes the screen's main action.
      event.preventDefault();
      screen.querySelector<HTMLElement>('[data-nav-default]')?.click();
    }
  }

  let lobbyInMatch = false;
  const unsubscribe = [
    ctx.events.on('matchState', onSnapshot),
    net.subscribe((lobby) => {
      // A match started from the lobby is one this interface started: a missing pointer lock opens the match menu.
      if (lobby.inMatch && !lobbyInMatch) startedHere = true;
      lobbyInMatch = lobby.inMatch;
    }),
    ctx.input.onLock((locked) => {
      if (locked && wantResume && phase === 'paused') finishResume();
    }),
  ];
  window.addEventListener('keydown', onKeyDown);

  return {
    dispose(): void {
      window.removeEventListener('keydown', onKeyDown);
      for (const off of unsubscribe) off();
      if (lockTimer !== null) clearTimeout(lockTimer);
      loading.end();
      menu.dispose();
      friend.dispose();
      settings.dispose();
      controls.dispose();
      stats.dispose();
      hud.dispose();
      root.remove();
      for (const link of fontLinks) link.remove();
    },
  };
}
