/**
 * The minimap: the level from above in the top right corner, turned so that the way the player faces is up, with a
 * dot for every living enemy. The layout is painted once per map; a frame only blits it and draws the markers.
 */
import type { Combatant, GameContext, MatchSnapshot } from '../../game/contracts';
import type { MapInstance } from '../../world/types';
import { flag, h } from '../dom';
import { buildLayout, CELL_SOLID, CELL_WALL, horizontalHalfFov, MINIMAP, shotAge, toMap, type Layout, type MapPoint } from './minimap-model';
import '../styles/minimap.css';

/** Layout canvas pixels per grid cell: a little more than a cell covers on a Retina screen, so walls stay sharp. */
const CELL_PIXELS = 3;
const INK = '#f2f0ea';
const EDGE = 'rgba(9, 9, 8, 0.85)';
const WALL = '#8a8882';
const FLOOR = 'rgba(242, 240, 234, 0.1)';
const CONE = 'rgba(242, 240, 234, 0.1)';
/** The co-op partner. Enemies already use the HUD's ink, so the partner takes the one accent. */
const PARTNER = '#4c8dff';
const DOT = 3.25;
const TICK = 6;
/** Space kept between the markers and the border. */
const INSET = 3;
const RIPPLE_SECONDS = 0.6;
const RIPPLE_GROWTH = 7;
const TAU = Math.PI * 2;

export interface Minimap {
  readonly element: HTMLElement;
  update(snapshot: MatchSnapshot): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

interface Shot {
  time: number;
  x: number;
  y: number;
  z: number;
}

/** Paint the layout: walls and cover in grey, floor as a faint tint, and the inside of solid things and everything outside the level left clear. */
function paintLayout(layout: Layout): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = layout.nx * CELL_PIXELS;
  canvas.height = layout.nz * CELL_PIXELS;
  const g = canvas.getContext('2d');
  if (!g) return canvas;
  for (let iz = 0; iz < layout.nz; iz++) {
    const row = iz * layout.nx;
    let start = 0;
    while (start < layout.nx) {
      const kind = layout.cells[row + start];
      let end = start + 1;
      while (end < layout.nx && layout.cells[row + end] === kind) end++;
      if (kind !== CELL_SOLID) {
        g.fillStyle = kind === CELL_WALL ? WALL : FLOOR;
        g.fillRect(start * CELL_PIXELS, iz * CELL_PIXELS, (end - start) * CELL_PIXELS, CELL_PIXELS);
      }
      start = end;
    }
  }
  return canvas;
}

export function createMinimap(ctx: GameContext): Minimap {
  const canvas = h('canvas', 'iv-minimap__canvas');
  const element = h('div', 'iv-minimap', canvas);
  element.setAttribute('aria-hidden', 'true');
  const g = canvas.getContext('2d');

  let layout: Layout | null = null;
  let layoutCanvas: HTMLCanvasElement | null = null;
  let builtFor: MapInstance | null = null;
  let visible = false;
  let duel = false;
  let partner: Combatant | null = null;
  /** CSS pixels across, and the device pixel ratio the canvas was sized for. 0 until measured. */
  let size = 0;
  let ratio = 1;
  let stale = true;

  const shots = new Map<number, Shot>();
  const point: MapPoint = { x: 0, y: 0, outside: false };
  const setEnabled = flag((on) => {
    element.hidden = !on;
    stale = true;
  }, true);

  function measure(): void {
    size = canvas.clientWidth;
    if (size === 0) return;
    ratio = window.devicePixelRatio || 1;
    canvas.width = canvas.height = Math.round(size * ratio);
    stale = false;
  }

  function dot(x: number, y: number, color: string, hollow: boolean): void {
    if (!g) return;
    g.beginPath();
    g.arc(x, y, hollow ? DOT - 0.75 : DOT, 0, TAU);
    if (hollow) {
      g.lineWidth = 3.5;
      g.strokeStyle = EDGE;
      g.stroke();
      g.lineWidth = 1.5;
      g.strokeStyle = color;
      g.stroke();
    } else {
      g.fillStyle = color;
      g.fill();
      g.lineWidth = 1;
      g.strokeStyle = EDGE;
      g.stroke();
    }
  }

  /** A short mark on the border, pointing at something past the edge of the map. */
  function tick(x: number, y: number, limit: number, color: string): void {
    if (!g) return;
    const inner = (limit - TICK) / limit;
    g.beginPath();
    g.moveTo(x * inner, y * inner);
    g.lineTo(x, y);
    g.lineCap = 'round';
    g.lineWidth = 4.5;
    g.strokeStyle = EDGE;
    g.stroke();
    g.lineWidth = 2.5;
    g.strokeStyle = color;
    g.stroke();
  }

  /** A ring that spreads from a shooter and fades, repeating while the shot is fresh. */
  function ripple(x: number, y: number, age: number): void {
    if (!g) return;
    const phase = (age % RIPPLE_SECONDS) / RIPPLE_SECONDS;
    g.globalAlpha *= 1 - phase;
    g.beginPath();
    g.arc(x, y, DOT + 1 + phase * RIPPLE_GROWTH, 0, TAU);
    g.lineWidth = 1.5;
    g.strokeStyle = INK;
    g.stroke();
  }

  function drawMinimap(): void {
    const enabled = ctx.settings.value.gameplay.minimap;
    setEnabled(enabled);
    if (!g || !visible || !enabled || !layout || !layoutCanvas) return;
    if (stale) measure();
    if (size === 0) return;

    const player = ctx.player;
    const half = size / 2;
    const scale = half / MINIMAP.range;
    const limit = half - INSET;
    const px = player.position.x;
    const py = player.position.y;
    const pz = player.position.z;
    const yaw = player.yaw;
    const now = ctx.time;

    // The level, turned about the player.
    g.setTransform(ratio, 0, 0, ratio, half * ratio, half * ratio);
    g.clearRect(-half, -half, size, size);
    g.rotate(yaw);
    g.scale(scale, scale);
    g.drawImage(layoutCanvas, layout.originX - px, layout.originZ - pz, layout.nx * layout.cell, layout.nz * layout.cell);
    g.setTransform(ratio, 0, 0, ratio, half * ratio, half * ratio);

    // What the player can see.
    const camera = ctx.engine.camera;
    const spread = horizontalHalfFov(camera.fov, camera.aspect);
    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, half, -Math.PI / 2 - spread, -Math.PI / 2 + spread);
    g.closePath();
    g.fillStyle = CONE;
    g.fill();

    const enemies = ctx.combat.enemiesOf(player.team);
    for (let i = 0; i < enemies.length; i++) {
      const enemy = enemies[i]!;
      const shot = shots.get(enemy.id);
      const age = shotAge(shot?.time, now);
      const fresh = age < MINIMAP.shotSeconds;
      if (duel) {
        // A duel opponent shows only as a fading mark where the shot came from.
        if (!fresh || !shot) continue;
        toMap(point, shot.x - px, shot.z - pz, yaw, scale, limit);
        g.globalAlpha = 1 - age / MINIMAP.shotSeconds;
        if (point.outside) tick(point.x, point.y, limit, INK);
        else dot(point.x, point.y, INK, Math.abs(shot.y - py) > MINIMAP.floorGap);
      } else {
        toMap(point, enemy.position.x - px, enemy.position.z - pz, yaw, scale, limit);
        if (point.outside) tick(point.x, point.y, limit, INK);
        else dot(point.x, point.y, INK, Math.abs(enemy.position.y - py) > MINIMAP.floorGap);
      }
      if (fresh && !point.outside) ripple(point.x, point.y, age);
      g.globalAlpha = 1;
    }

    if (partner?.alive) {
      toMap(point, partner.position.x - px, partner.position.z - pz, yaw, scale, limit);
      if (point.outside) tick(point.x, point.y, limit, PARTNER);
      else dot(point.x, point.y, PARTNER, Math.abs(partner.position.y - py) > MINIMAP.floorGap);
    }

    // The player: an arrowhead at the centre, always pointing up.
    g.beginPath();
    g.moveTo(0, -6);
    g.lineTo(4.5, 4.5);
    g.lineTo(0, 2);
    g.lineTo(-4.5, 4.5);
    g.closePath();
    g.fillStyle = INK;
    g.fill();
    g.lineWidth = 1;
    g.strokeStyle = EDGE;
    g.stroke();
  }

  const markStale = (): void => {
    stale = true;
  };
  window.addEventListener('resize', markStale);

  const unsubscribe = [
    ctx.events.on('shotFired', (event) => {
      if (event.local) return;
      let shot = shots.get(event.shooterId);
      if (!shot) {
        shot = { time: 0, x: 0, y: 0, z: 0 };
        shots.set(event.shooterId, shot);
      }
      shot.time = ctx.time;
      shot.x = event.muzzle.x;
      shot.y = event.muzzle.y;
      shot.z = event.muzzle.z;
    }),
    ctx.engine.onFrame(drawMinimap),
  ];

  return {
    element,
    update(snapshot: MatchSnapshot): void {
      const map = ctx.map;
      if (map && map !== builtFor) {
        builtFor = map;
        layout = buildLayout(ctx.bots.grid);
        layoutCanvas = paintLayout(layout);
        shots.clear();
      }
      const net = snapshot.net ?? null;
      duel = snapshot.config?.mode === 'duel';
      partner = null;
      if (net && !duel) {
        const team = ctx.player.team;
        partner = ctx.combat.all().find((other) => other.kind === 'remote' && other.team === team) ?? null;
      }
    },
    setVisible(next: boolean): void {
      visible = next;
      if (next) stale = true;
    },
    dispose(): void {
      for (const off of unsubscribe) off();
      window.removeEventListener('resize', markStale);
    },
  };
}
