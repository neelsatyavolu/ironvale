import type { FireMode, GameContext, MatchSnapshot, WeaponClass } from '../../game/contracts';
import type { NetSnapshot } from '../../net/api';
import { healthEffects } from '../damage';
import { flag, h, textSlot } from '../dom';
import { livesLeft, respawnCountdown, rulesOf } from '../format';
import { createExtras } from './extras';
import { createFeed } from './feed';
import { createPerf } from './perf';
import { createReticle } from './reticle';
import { createScope } from './scope';
import '../styles/hud.css';

const LOW_HEALTH = 35;
/** Seconds before a respawn in Skirmish. Mirrors `src/game/game.ts`, which does not publish it. */
const RESPAWN_SECONDS = 3;
const TOAST_MS = 1500;

const FIRE_MODES: Readonly<Record<FireMode, string>> = {
  semi: 'Semi',
  auto: 'Auto',
  bolt: 'Bolt action',
  pump: 'Pump action',
};

const WEAPON_CLASSES: Readonly<Record<WeaponClass, string>> = {
  pistol: 'Pistol',
  rifle: 'Rifle',
  carbine: 'Carbine',
  smg: 'Submachine gun',
  shotgun: 'Shotgun',
  sniper: 'Sniper rifle',
  lmg: 'Machine gun',
};

export interface Hud {
  readonly element: HTMLElement;
  update(snapshot: MatchSnapshot): void;
  setVisible(visible: boolean): void;
  togglePerf(): void;
  dispose(): void;
}

function figure(label: string, className = ''): { element: HTMLElement; label: ReturnType<typeof textSlot>; value: ReturnType<typeof textSlot> } {
  const value = textSlot('span', 'iv-fig__value', '0');
  const name = textSlot('span', 'iv-fig__label', label);
  const element = h('div', `iv-fig ${className}`.trim(), name.element, value.element);
  return { element, label: name, value };
}

/** What the HUD says about the other player, or an empty string. */
function noticeText(net: NetSnapshot | null): string {
  if (!net) return '';
  switch (net.notice) {
    case 'waiting-peer':
      return `Waiting for ${net.peerName} to finish loading`;
    case 'peer-away':
      return `${net.peerName} has switched away from the game`;
    case 'peer-left':
      return `${net.peerName} disconnected. You are carrying on alone.`;
    case 'peer-timeout':
      return `The connection to ${net.peerName} was lost. You are carrying on alone.`;
    case 'took-over':
      return `${net.peerName} disconnected. The enemies have regrouped and you are carrying on alone.`;
    default:
      return '';
  }
}

/** The in-match overlay. Never takes the pointer and only touches the DOM when a value changes. */
export function createHud(ctx: GameContext, roundTripMs: () => number = () => -1): Hud {
  const weaponNames = new Map<string, string>();
  const weaponName = (id: string): string => weaponNames.get(id) ?? id.toUpperCase();

  const reticle = createReticle(ctx);
  const scope = createScope();
  const perf = createPerf(ctx, roundTripMs);
  const feed = createFeed(() => ctx.player.name, weaponName);
  const extras = createExtras(ctx);

  // Top left: what is left to do.
  const enemies = figure('Enemies');
  const wave = figure('Wave');
  const lives = figure('Lives');
  // A duel shows the score here instead: both names and their kills.
  const scoreYou = figure('You');
  const scorePeer = figure('Friend');
  const scoreTarget = figure('First to');
  const status = h(
    'div',
    'iv-hud__status',
    enemies.element,
    wave.element,
    lives.element,
    scoreYou.element,
    scorePeer.element,
    scoreTarget.element,
  );

  // Top centre: the countdown and anything worth knowing about the other player.
  const countdown = textSlot('span', 'iv-net__count');
  const countdownBox = h('div', 'iv-net__start', h('span', 'iv-fig__label', 'Starting in'), countdown.element);
  countdownBox.hidden = true;
  const notice = textSlot('p', 'iv-net__notice');
  notice.element.setAttribute('role', 'status');
  const netBox = h('div', 'iv-net', countdownBox, notice.element);

  // Bottom left: health.
  const health = figure('Health', 'iv-health');
  const healthFill = h('i', 'iv-health__fill');
  health.element.append(h('span', 'iv-health__bar', healthFill));

  // Bottom right: ammunition.
  const magazine = textSlot('span', 'iv-ammo__mag', '0');
  const reserve = textSlot('span', 'iv-ammo__reserve', '0');
  const weapon = textSlot('span', 'iv-ammo__weapon');
  const ammo = h(
    'div',
    'iv-ammo',
    h('div', 'iv-ammo__count', magazine.element, h('span', 'iv-ammo__slash', '/'), reserve.element),
    weapon.element,
  );

  // Centre: notes that sit near the line of sight.
  const reloading = h('div', 'iv-hud__reload', 'Reloading');
  const toastName = textSlot('span', 'iv-toast__name');
  const toastClass = textSlot('span', 'iv-toast__class');
  const toast = h('div', 'iv-toast', toastName.element, toastClass.element);
  const deathCause = textSlot('p', 'iv-death__cause');
  const deathNext = textSlot('p', 'iv-death__next');
  const death = h('div', 'iv-death', h('p', 'iv-death__title', 'You were hit'), deathCause.element, deathNext.element);
  death.hidden = true;

  const vignette = h('div', 'iv-hud__vignette');
  const desaturate = h('div', 'iv-hud__desat');
  desaturate.hidden = true;

  const element = h(
    'div',
    'iv-hud',
    desaturate,
    vignette,
    scope.element,
    h('div', 'iv-hud__safe', status, netBox, feed.element, health.element, ammo, reticle.element, reloading, toast, death, extras.element),
    perf.element,
  );
  element.hidden = true;

  const setLow = flag((on) => health.element.classList.toggle('is-low', on));
  const setEmpty = flag((on) => ammo.classList.toggle('is-empty', on));
  const setReloading = flag((on) => reloading.classList.toggle('is-on', on));
  const setWave = flag((on) => {
    wave.element.hidden = !on;
  }, true);
  const setLives = flag((on) => {
    lives.element.hidden = !on;
  }, true);
  const setEnemies = flag((on) => {
    enemies.element.hidden = !on;
  }, true);
  const setScore = flag((on) => {
    scoreYou.element.hidden = scorePeer.element.hidden = scoreTarget.element.hidden = !on;
  }, true);
  const setCountdown = flag((on) => {
    countdownBox.hidden = !on;
  });
  const setDead = flag((on) => {
    death.hidden = !on;
    element.classList.toggle('is-dead', on);
  });

  let aiming = false;
  let lastHealth = -1;
  let diedAt = 0;
  let wasDead = false;
  let toastAnimation: Animation | null = null;
  let latest: MatchSnapshot | null = null;

  function refreshCrosshair(): void {
    const alive = (latest?.health ?? 0) > 0;
    const scoped = latest?.scopedIn ?? false;
    reticle.setCrosshair(ctx.settings.value.gameplay.crosshair && alive && !aiming && !scoped);
  }

  function applyHealth(value: number): void {
    if (value === lastHealth) return;
    lastHealth = value;
    const clamped = Math.min(100, Math.max(0, value));
    health.value.set(String(clamped));
    healthFill.style.transform = `scaleX(${(clamped / 100).toFixed(3)})`;
    setLow(clamped < LOW_HEALTH);
    const effects = healthEffects(clamped);
    vignette.style.opacity = effects.vignette.toFixed(2);
    desaturate.hidden = effects.saturation === 1;
    desaturate.style.backdropFilter = `saturate(${effects.saturation.toFixed(2)})`;
  }

  const unsubscribe = [
    ctx.events.on('shotFired', (event) => {
      if (!weaponNames.has(event.weapon.id)) weaponNames.set(event.weapon.id, event.weapon.name);
    }),
    ctx.events.on('combatantHit', (event) => {
      if (event.attackerId !== ctx.player.id || event.targetId === ctx.player.id) return;
      if (ctx.settings.value.gameplay.showHitMarkers) reticle.hit(event.fatal);
    }),
    ctx.events.on('playerHurt', (event) => reticle.hurt(event.direction.x, event.direction.z)),
    ctx.events.on('aimChanged', (event) => {
      aiming = event.aiming;
      refreshCrosshair();
    }),
    ctx.events.on('weaponSwitch', (event) => {
      weaponNames.set(event.weapon.id, event.weapon.name);
      if (!event.local) return;
      aiming = false;
      refreshCrosshair();
      toastName.set(event.weapon.name);
      toastClass.set(WEAPON_CLASSES[event.weapon.weaponClass]);
      toastAnimation?.cancel();
      toastAnimation = toast.animate([{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], {
        duration: TOAST_MS,
        easing: 'linear',
      });
    }),
    ctx.events.on('died', (event) => {
      if (event.victimId !== ctx.player.id) return;
      const killer = ctx.combat.get(event.killerId);
      deathCause.set(killer && killer.id !== ctx.player.id ? `${killer.name}, ${weaponName(event.weaponId)}` : '');
    }),
    ctx.settings.subscribe((next, previous) => {
      if (next.gameplay.crosshair !== previous.gameplay.crosshair) refreshCrosshair();
    }),
  ];

  return {
    element,
    update(snapshot: MatchSnapshot): void {
      latest = snapshot;
      const mode = rulesOf(snapshot.config);
      const net = snapshot.net ?? null;
      const duel = mode === 'duel';
      setEnemies(!duel);
      enemies.value.set(String(snapshot.enemiesRemaining));
      setWave(snapshot.wave > 0);
      wave.value.set(String(snapshot.wave));
      setLives(mode === 'skirmish');
      lives.value.set(String(livesLeft(mode, snapshot.deaths)));
      setScore(duel && net !== null);
      if (duel && net) {
        scoreYou.label.set(net.localName);
        scoreYou.value.set(String(snapshot.kills));
        scorePeer.label.set(net.peerName);
        scorePeer.value.set(String(net.peerKills));
        scoreTarget.value.set(String(net.killTarget));
      }
      setCountdown(net !== null && net.countdown > 0);
      if (net && net.countdown > 0) countdown.set(String(net.countdown));
      notice.set(noticeText(net));

      applyHealth(snapshot.health);
      magazine.set(String(snapshot.magazine));
      reserve.set(String(snapshot.reserve));
      setEmpty(snapshot.magazine === 0);
      weapon.set(snapshot.fireMode ? `${snapshot.weaponName} · ${FIRE_MODES[snapshot.fireMode]}` : snapshot.weaponName);
      setReloading(snapshot.reloading && snapshot.health > 0);
      scope.set(snapshot.scopedIn && snapshot.health > 0);
      feed.update(snapshot.killFeed, snapshot.elapsed);
      reticle.track();
      refreshCrosshair();

      const dead = snapshot.health <= 0 && snapshot.phase !== 'loading';
      if (dead && !wasDead) diedAt = snapshot.elapsed;
      wasDead = dead;
      setDead(dead);
      if (!dead) return;
      const left = livesLeft(mode, snapshot.deaths);
      if (duel) deathNext.set(`Back in ${respawnCountdown(diedAt, snapshot.elapsed, RESPAWN_SECONDS)}`);
      else if (left === 0) {
        const partnerFighting = snapshot.config?.mode === 'coop' && net?.peerConnected === true;
        deathNext.set(mode === 'skirmish' ? 'No lives left' : partnerFighting ? 'Back when the next wave starts' : '');
      } else {
        const seconds = respawnCountdown(diedAt, snapshot.elapsed, RESPAWN_SECONDS);
        deathNext.set(`${left === 1 ? '1 life' : `${left} lives`} left · back in ${seconds}`);
      }
    },
    setVisible: flag((visible) => {
      element.hidden = !visible;
      if (!visible) {
        reticle.clear();
        toastAnimation?.cancel();
        aiming = false;
      }
    }),
    togglePerf: perf.toggle,
    dispose(): void {
      for (const off of unsubscribe) off();
      extras.dispose();
      perf.dispose();
    },
  };
}
