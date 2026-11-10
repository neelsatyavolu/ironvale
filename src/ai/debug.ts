import * as THREE from 'three/webgpu';
import type { BotState } from './blackboard';
import type { Bot } from './bot';
import type { NavGrid } from './navgrid';

/** What `?botdebug` shows: nothing extra, cover cells (`=cover`) or every walkable cell (`=nav`). */
export type DebugLayer = 'paths' | 'cover' | 'nav';

const STATE_COLORS: Readonly<Record<BotState, number>> = {
  patrol: 0x8fa3b8,
  investigate: 0xf2d544,
  cover: 0x4cd964,
  strafe: 0xff9f43,
  push: 0xff4d4d,
  flank: 0xe056fd,
  suppress: 0xffffff,
  fallback: 0x48dbfb,
  hold: 0x5f8dff,
  dead: 0x555555,
};

const MAX_BOTS = 32;
/** Path legs plus the line to the last known position, per bot. */
const SEGMENTS_PER_BOT = 50;
const RIBBON_WIDTH = 0.09;
const RIBBON_LIFT = 0.06;
const SIGHT_LINE_WIDTH = 0.015;
const SIGHT_LINE_GAP = 2.5;
const LABEL_HEIGHT = 2.15;
const LOG_LIMIT = 500;

interface Label {
  readonly sprite: THREE.Sprite;
  readonly canvas: HTMLCanvasElement;
  readonly texture: THREE.CanvasTexture;
  text: string;
}

/**
 * Developer view behind `?botdebug`: each bot's path as a ribbon on the
 * ground in its state colour, a line to where it thinks the enemy is, and a
 * label with its role, state and health. State changes are logged.
 */
export class BotDebug {
  readonly log: string[] = [];
  private readonly group = new THREE.Group();
  private readonly positions = new Float32Array(MAX_BOTS * SEGMENTS_PER_BOT * 18);
  private readonly colors = new Float32Array(MAX_BOTS * SEGMENTS_PER_BOT * 18);
  private readonly ribbons: THREE.Mesh;
  private readonly labels = new Map<number, Label>();
  private cells: THREE.Mesh | null = null;
  private readonly color = new THREE.Color();
  private cursor = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly layer: DebugLayer,
  ) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.ribbons = new THREE.Mesh(geometry, overlayMaterial());
    this.ribbons.frustumCulled = false;
    this.ribbons.visible = false;
    this.ribbons.renderOrder = 998;
    this.group.add(this.ribbons);
    this.group.name = 'bot-debug';
    scene.add(this.group);
  }

  transition(bot: Bot, from: BotState, to: BotState, reason: string, time: number): void {
    const line = `${time.toFixed(1)}s #${bot.id} ${bot.name} (${bot.role}) ${from} -> ${to}: ${reason}`;
    this.log.push(line);
    if (this.log.length > LOG_LIMIT) this.log.shift();
    console.info(`[bots] ${line}`);
  }

  /** Show cover cells (and all walkable cells on the `nav` layer) as small tiles. */
  showGrid(grid: NavGrid): void {
    this.clearGrid();
    if (this.layer === 'paths') return;
    const tiles: number[] = [];
    const tints: number[] = [];
    for (let n = 0; n < grid.nodeCount; n++) {
      if (grid.edges[n] === 0) continue;
      const low = grid.coverLow[n] ?? 0;
      const high = grid.coverHigh[n] ?? 0;
      if (low === 0 && this.layer !== 'nav') continue;
      this.color.set(high !== 0 ? 0xff7a1a : low !== 0 ? 0xffe14d : 0x2e7d5b);
      const half = low !== 0 ? 0.2 : 0.07;
      pushQuad(tiles, tints, grid.nodeX(n), (grid.nodeY[n] ?? 0) + 0.04, grid.nodeZ(n), half, this.color);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(tiles, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(tints, 3));
    this.cells = new THREE.Mesh(geometry, overlayMaterial(true));
    this.cells.renderOrder = 997;
    this.group.add(this.cells);
  }

  /** Redraw paths and labels. Debug only, so it may allocate a little. */
  update(bots: readonly Bot[]): void {
    this.cursor = 0;
    const seen = new Set<number>();
    for (const bot of bots) {
      seen.add(bot.id);
      this.label(bot);
      if (!bot.alive) continue;
      this.color.set(STATE_COLORS[bot.state]);
      // Wider from far away, so paths still read in an overview.
      const width = THREE.MathUtils.clamp(bot.position.distanceTo(this.camera.position) * 0.005, RIBBON_WIDTH, 0.5);
      let x = bot.position.x;
      let y = bot.position.y;
      let z = bot.position.z;
      const path = bot.path;
      if (bot.moving && path.status === 'ready') {
        for (let i = bot.waypointIndex; i < path.count; i++) {
          const nx = path.points[i * 3] ?? x;
          const ny = path.points[i * 3 + 1] ?? y;
          const nz = path.points[i * 3 + 2] ?? z;
          this.ribbon(x, y, z, nx, ny, nz, width);
          x = nx;
          y = ny;
          z = nz;
        }
      }
      if (bot.inCombat) {
        // Thin red line from the head toward where the soldier believes the enemy is,
        // stopping short so it does not fill the player's own view.
        this.color.set(bot.targetVisible ? 0xff2d2d : 0x8a2d2d);
        const p = bot.position;
        const k = bot.lastKnown;
        const reach = Math.max(0, 1 - SIGHT_LINE_GAP / Math.max(0.001, p.distanceTo(k)));
        this.ribbon(p.x, p.y + 1.5, p.z, p.x + (k.x - p.x) * reach, p.y + 1.5 + (k.y - p.y - 0.3) * reach, p.z + (k.z - p.z) * reach, SIGHT_LINE_WIDTH);
      }
    }
    this.ribbons.visible = this.cursor > 0;
    this.ribbons.geometry.setDrawRange(0, this.cursor / 3);
    this.ribbons.geometry.getAttribute('position').needsUpdate = true;
    this.ribbons.geometry.getAttribute('color').needsUpdate = true;
    for (const [id, label] of this.labels) {
      if (seen.has(id)) continue;
      this.group.remove(label.sprite);
      label.texture.dispose();
      label.sprite.material.dispose();
      this.labels.delete(id);
    }
  }

  dispose(): void {
    this.clearGrid();
    for (const label of this.labels.values()) {
      label.texture.dispose();
      label.sprite.material.dispose();
    }
    this.labels.clear();
    this.ribbons.geometry.dispose();
    this.scene.remove(this.group);
  }

  private clearGrid(): void {
    if (!this.cells) return;
    this.group.remove(this.cells);
    this.cells.geometry.dispose();
    this.cells = null;
  }

  /** A flat strip on the ground between two points. */
  private ribbon(ax: number, ay: number, az: number, bx: number, by: number, bz: number, width: number): void {
    if (this.cursor + 18 > this.positions.length) return;
    const dx = bx - ax;
    const dz = bz - az;
    const length = Math.hypot(dx, dz) || 1;
    const sx = (-dz / length) * width;
    const sz = (dx / length) * width;
    const p = this.positions;
    const c = this.colors;
    const corners = [
      ax - sx, ay + RIBBON_LIFT, az - sz,
      bx - sx, by + RIBBON_LIFT, bz - sz,
      bx + sx, by + RIBBON_LIFT, bz + sz,
      ax - sx, ay + RIBBON_LIFT, az - sz,
      bx + sx, by + RIBBON_LIFT, bz + sz,
      ax + sx, ay + RIBBON_LIFT, az + sz,
    ];
    for (let i = 0; i < 18; i++) {
      p[this.cursor + i] = corners[i] ?? 0;
      c[this.cursor + i] = i % 3 === 0 ? this.color.r : i % 3 === 1 ? this.color.g : this.color.b;
    }
    this.cursor += 18;
  }

  private label(bot: Bot): void {
    let label = this.labels.get(bot.id);
    if (!label) {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 96;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.SpriteNodeMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
      material.fog = false;
      const sprite = new THREE.Sprite(material);
      sprite.renderOrder = 999;
      label = { sprite, canvas, texture, text: '' };
      this.labels.set(bot.id, label);
      this.group.add(sprite);
    }
    const sight = bot.targetVisible ? ' [sees]' : bot.awareness.alerted ? ' [alert]' : '';
    const gun = bot.weapon.reloading ? 'reload' : `${bot.weapon.magazine}`;
    const text = `#${bot.id} ${bot.role} ${bot.state}${sight}|hp ${Math.ceil(bot.health)} ammo ${gun}`;
    if (text !== label.text) {
      label.text = text;
      draw(label.canvas, text, STATE_COLORS[bot.state]);
      label.texture.needsUpdate = true;
    }
    label.sprite.position.set(bot.position.x, bot.position.y + (bot.alive ? LABEL_HEIGHT : 0.6), bot.position.z);
    // Keep labels readable from across the map.
    const size = THREE.MathUtils.clamp(label.sprite.position.distanceTo(this.camera.position) * 0.05, 0.6, 5);
    label.sprite.scale.set(size * (512 / 96), size, 1);
  }
}

function overlayMaterial(seeThrough = false): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: seeThrough ? 0.55 : 0.95,
    depthWrite: false,
    depthTest: seeThrough,
  });
  material.fog = false;
  return material;
}

function pushQuad(positions: number[], colors: number[], x: number, y: number, z: number, half: number, color: THREE.Color): void {
  positions.push(
    x - half, y, z - half, x - half, y, z + half, x + half, y, z + half,
    x - half, y, z - half, x + half, y, z + half, x + half, y, z - half,
  );
  for (let i = 0; i < 6; i++) colors.push(color.r, color.g, color.b);
}

function draw(canvas: HTMLCanvasElement, text: string, color: number): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  const [top = '', bottom = ''] = text.split('|');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'rgba(14, 14, 13, 0.78)';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  context.fillRect(0, 0, 8, canvas.height);
  context.font = '600 30px ui-monospace, Menlo, monospace';
  context.textBaseline = 'middle';
  context.fillText(top, 20, 30);
  context.fillStyle = '#f7f5ef';
  context.font = '26px ui-monospace, Menlo, monospace';
  context.fillText(bottom, 20, 68);
}

/** Bytes held by a grid's typed arrays, for the stats readout. */
export function gridBytes(grid: NavGrid): number {
  return (
    grid.colStart.byteLength +
    grid.nodeY.byteLength +
    grid.nodeCol.byteLength +
    grid.edges.byteLength +
    grid.edgeLayers.byteLength +
    grid.coverLow.byteLength +
    grid.coverHigh.byteLength +
    grid.wet.byteLength
  );
}
