/**
 * HUD additions that react to play: the weapon list (hold Tab, or shown briefly
 * on every switch), a note for each kill, and health bars over enemies the
 * player has just hit.
 */
import { Vector3 } from 'three/webgpu';
import type { GameContext } from '../../game/contracts';
import { WEAPON_DEFS } from '../../weapons/defs';
import { h } from '../dom';
import '../styles/hud-extras.css';

const WEAPON_LIST_MS = 1600;
const KILL_NOTE_MS = 1800;
/** Kills this close together count as a streak. */
const STREAK_SECONDS = 4;
const BAR_SECONDS = 3;
const BAR_POOL = 6;
const STREAK_NAMES = ['', '', 'Double kill', 'Triple kill', 'Four in a row', 'Five in a row'];

export interface HudExtras {
  readonly element: HTMLElement;
  dispose(): void;
}

export function killNote(headshot: boolean, streak: number, distance: number): string {
  const parts = [streak >= 2 ? (STREAK_NAMES[streak] ?? `${streak} in a row`) : 'Enemy down'];
  if (headshot) parts.push('Headshot');
  if (distance >= 60) parts.push(`${Math.round(distance)} m`);
  return parts.join(' · ');
}

export function createExtras(ctx: GameContext): HudExtras {
  // Weapon list.
  const weapons = Object.values(WEAPON_DEFS).sort((a, b) => a.slot - b.slot);
  const rows = new Map(
    weapons.map((def) => [
      def.id,
      h('li', 'iv-wlist__row', h('span', 'iv-wlist__key', String(def.slot)), h('span', 'iv-wlist__name', def.name)),
    ]),
  );
  const list = h('ol', 'iv-wlist', ...rows.values());
  let currentId = '';
  let listUntil = 0;
  const markCurrent = (id: string): void => {
    if (id === currentId) return;
    rows.get(currentId)?.classList.remove('is-current');
    rows.get(id)?.classList.add('is-current');
    currentId = id;
  };

  // Kill note.
  const note = h('div', 'iv-kill');
  note.setAttribute('role', 'status');
  let noteAnimation: Animation | null = null;
  let streak = 0;
  let lastKillAt = -Infinity;

  // Enemy health bars.
  const bars = Array.from({ length: BAR_POOL }, () => {
    const fill = h('i', 'iv-ebar__fill');
    const element = h('div', 'iv-ebar', fill);
    element.hidden = true;
    return { element, fill, shown: false };
  });
  const recent = new Map<number, number>();
  const point = new Vector3();

  const element = h('div', 'iv-extras', list, note, ...bars.map((bar) => bar.element));
  let listShown = false;

  const unsubscribe = [
    ctx.events.on('weaponSwitch', (event) => {
      if (!event.local) return;
      markCurrent(event.weapon.id);
      listUntil = performance.now() + WEAPON_LIST_MS;
    }),
    ctx.events.on('combatantHit', (event) => {
      if (event.attackerId !== ctx.player.id || event.targetId === ctx.player.id) return;
      recent.set(event.targetId, ctx.time + BAR_SECONDS);
    }),
    ctx.events.on('died', (event) => {
      if (event.victimId === ctx.player.id) streak = 0;
      if (event.killerId !== ctx.player.id || event.victimId === ctx.player.id) return;
      streak = ctx.time - lastKillAt <= STREAK_SECONDS ? streak + 1 : 1;
      lastKillAt = ctx.time;
      const victim = ctx.combat.get(event.victimId);
      const distance = victim ? victim.position.distanceTo(ctx.player.position) : 0;
      note.textContent = killNote(event.headshot, streak, distance);
      noteAnimation?.cancel();
      noteAnimation = note.animate(
        [
          { opacity: 0, transform: 'translate(-50%, 6px)' },
          { opacity: 1, transform: 'translate(-50%, 0)', offset: 0.1 },
          { opacity: 1, transform: 'translate(-50%, 0)', offset: 0.75 },
          { opacity: 0, transform: 'translate(-50%, 0)' },
        ],
        { duration: KILL_NOTE_MS, easing: 'ease-out' },
      );
    }),
    ctx.engine.onFrame(() => {
      const wantList = ctx.input.isDown('scores') || performance.now() < listUntil;
      if (wantList !== listShown) {
        listShown = wantList;
        list.classList.toggle('is-on', wantList);
      }

      const width = window.innerWidth;
      const height = window.innerHeight;
      let used = 0;
      for (const [id, until] of recent) {
        const target = ctx.combat.get(id);
        if (!target || !target.alive || until < ctx.time) {
          recent.delete(id);
          continue;
        }
        if (used >= BAR_POOL) continue;
        target.eyePosition(point);
        point.y += 0.32;
        point.project(ctx.engine.camera);
        if (point.z > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1) continue;
        const bar = bars[used++]!;
        const x = (point.x * 0.5 + 0.5) * width;
        const y = (-point.y * 0.5 + 0.5) * height;
        bar.element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
        bar.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, target.health / 100)).toFixed(2)})`;
        if (!bar.shown) {
          bar.shown = true;
          bar.element.hidden = false;
        }
      }
      for (let i = used; i < BAR_POOL; i++) {
        const bar = bars[i]!;
        if (!bar.shown) continue;
        bar.shown = false;
        bar.element.hidden = true;
      }
    }),
  ];

  return {
    element,
    dispose(): void {
      for (const off of unsubscribe) off();
      noteAnimation?.cancel();
    },
  };
}
