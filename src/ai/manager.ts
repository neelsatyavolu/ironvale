import { MathUtils, Vector3 } from 'three/webgpu';
import { createSoldier, soldierAssets } from '../characters/index';
import { hashString, seededRandom } from '../core/random';
import type { Difficulty } from '../core/settings';
import type { BotSystem, Combatant, GameContext, GameEvents, SoldierVisual, Team } from '../game/contracts';
import type { MapInstance } from '../world/types';
import { Squad, type BotState, type CalloutKind } from './blackboard';
import { BODY } from './body';
import { Bot } from './bot';
import type { BotEnv } from './env';
import { think } from './brain';
import { BotDebug, gridBytes, type DebugLayer } from './debug';
import { buildNavGrid, type NavGrid } from './navgrid';
import { PathQueue } from './pathfinder';
import { hearingRadius } from './perception';
import { assignRoles, botName } from './roles';
import { assignSpawns, inViewCone, orderSpawns } from './spawn';

/** Each soldier senses and decides this often; the calls are spread across frames. */
const THINK_INTERVAL = 1 / 7;
const THINK_JITTER = 0.2;
const MAX_THINKS_PER_FRAME = 4;
/** Path search nodes expanded per frame, shared by every soldier. */
const PATH_BUDGET = 350;
/** Milliseconds of navigation building before yielding to the browser. */
const BUILD_SLICE_MS = 8;
const CORPSE_SECONDS = 20;
const ENEMY_REFRESH_SECONDS = 0.5;
const SPAWN_CAPACITY = 4;
const SPAWN_RING = 1.4;
const PLAYER_VIEW_HALF_ANGLE = MathUtils.degToRad(65);
const MAX_FRAME_SECONDS = 0.1;
const SLOW_FRAME_MS = 1.5;
/** Once the quiet spell is over, patrols drift to the player over this long, one soldier after another. */
const SWEEP_RAMP_SECONDS = 10;
const SWEEP_STAGGER_SECONDS = 1.5;

/** Timing and size figures for developer tools; read them from `game.bots.stats`. */
export interface BotStats {
  navNodes: number;
  navBuildMs: number;
  navBytes: number;
  frames: number;
  /** Mean milliseconds per frame over the whole match, and the worst frame, for each part. */
  updateMs: number;
  updateMaxMs: number;
  pathMs: number;
  pathMaxMs: number;
  thinkMs: number;
  thinkMaxMs: number;
  bodyMs: number;
  bodyMaxMs: number;
  /** Frames in which the whole update took longer than 1.5 ms. */
  slowFrames: number;
}

const calloutEvent: GameEvents['botCallout'] = { botId: 0, kind: 'spotted', position: new Vector3() };
const eye = new Vector3();
const chest = new Vector3();
const segment = new Vector3();
const offset = new Vector3();

/** Owns the navigation data and every bot; the `BotSystem` the game talks to. */
export class BotManager implements BotSystem, BotEnv {
  readonly squad = new Squad();
  readonly bots: Bot[] = [];
  readonly random = seededRandom(hashString('ironvale-bots'));
  time = 0;
  fogDensity = 0.006;
  enemies: readonly Combatant[] = [];
  readonly stats: BotStats = {
    navNodes: 0,
    navBuildMs: 0,
    navBytes: 0,
    frames: 0,
    updateMs: 0,
    updateMaxMs: 0,
    pathMs: 0,
    pathMaxMs: 0,
    thinkMs: 0,
    thinkMaxMs: 0,
    bodyMs: 0,
    bodyMaxMs: 0,
    slowFrames: 0,
  };

  private nav: NavGrid | null = null;
  private queue: PathQueue | null = null;
  private buildToken = 0;
  private spawned = 0;
  private sweepFrom = 0;
  private enemyTimer = 0;
  private thinkCursor = 0;
  private readonly pool = new Map<Team, SoldierVisual[]>();
  private readonly unsubscribe: (() => void)[];
  private readonly debugLayer: DebugLayer | null;
  private debug: BotDebug | null = null;
  private readonly lastMuzzle = new Vector3();
  private lastShotTeam: Team | null = null;

  constructor(readonly ctx: GameContext) {
    const events = ctx.events;
    this.unsubscribe = [
      events.on('shotFired', (event) => this.onShot(event)),
      events.on('bulletTrace', (event) => this.onTrace(event)),
      events.on('bulletImpact', (event) => this.onImpact(event)),
      events.on('footstep', (event) => this.onFootstep(event)),
    ];
    const param = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('botdebug');
    this.debugLayer = param === null ? null : param === 'cover' || param === 'nav' ? param : 'paths';
  }

  get grid(): NavGrid {
    if (!this.nav) throw new Error('Bots used before the navigation grid was built');
    return this.nav;
  }

  get paths(): PathQueue {
    if (!this.queue) throw new Error('Bots used before the navigation grid was built');
    return this.queue;
  }

  get alive(): number {
    let count = 0;
    for (const bot of this.bots) if (bot.alive) count++;
    return count;
  }

  async enterMap(map: MapInstance): Promise<void> {
    this.leaveMap();
    const token = this.buildToken;
    await this.ctx.assets.preload(soldierAssets());
    if (token !== this.buildToken) return;

    const started = performance.now();
    const seeds = [...map.enemySpawns, ...map.playerSpawns].map((spawn) => spawn.position);
    const builder = buildNavGrid(this.ctx.world, map.bounds, seeds);
    let sliceStart = performance.now();
    let step = builder.next();
    while (!step.done) {
      if (performance.now() - sliceStart > BUILD_SLICE_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (token !== this.buildToken) return;
        sliceStart = performance.now();
      }
      step = builder.next();
    }
    const grid = step.value;
    this.nav = grid;
    this.queue = new PathQueue(grid);
    this.fogDensity = map.lighting.fog.density;
    this.time = 0;
    this.sweepFrom = 0;
    for (const spawn of map.enemySpawns) {
      if (grid.nearestNode(spawn.position.x, spawn.position.y, spawn.position.z) < 0) {
        console.warn(`Enemy spawn at ${spawn.position.x.toFixed(1)}, ${spawn.position.z.toFixed(1)} is not on walkable ground`);
      }
    }
    const stats = this.stats;
    stats.navNodes = grid.nodeCount;
    stats.navBuildMs = performance.now() - started;
    stats.navBytes = gridBytes(grid);
    stats.frames = stats.slowFrames = 0;
    stats.updateMs = stats.pathMs = stats.thinkMs = stats.bodyMs = 0;
    stats.updateMaxMs = stats.pathMaxMs = stats.thinkMaxMs = stats.bodyMaxMs = 0;
    if (this.debugLayer) {
      this.debug = new BotDebug(this.ctx.engine.scene, this.ctx.engine.camera, this.debugLayer);
      this.debug.showGrid(grid);
      const debug = this.debug;
      (window as unknown as { __ironvaleBots?: unknown }).__ironvaleBots = {
        log: debug.log,
        stats,
        bots: () =>
          this.bots.map((bot) => ({
            id: bot.id,
            name: bot.name,
            role: bot.role,
            state: bot.state,
            phase: bot.phase,
            crouching: bot.crouching,
            cover: bot.coverNode,
            alive: bot.alive,
            health: bot.health,
            sees: bot.targetVisible,
            alerted: bot.awareness.alerted,
            moving: bot.moving,
            magazine: bot.weapon.magazine,
            position: bot.position.toArray().map((v) => Math.round(v * 10) / 10),
          })),
      };
    }
  }

  leaveMap(): void {
    this.buildToken++;
    for (let i = this.bots.length - 1; i >= 0; i--) this.retire(i);
    this.queue?.clear();
    this.queue = null;
    this.nav = null;
    this.enemies = [];
    this.squad.reset();
    this.lastShotTeam = null;
    this.debug?.dispose();
    this.debug = null;
  }

  spawn(count: number, team: Team, difficulty: Difficulty): void {
    const map = this.ctx.map;
    const grid = this.nav;
    if (!map || !grid || count <= 0) return;
    const { player, world } = this.ctx;
    player.eyePosition(eye);
    const order = orderSpawns(map.enemySpawns, player.position, (index) => {
      const spawn = map.enemySpawns[index];
      if (!spawn || !inViewCone(player.position, player.yaw, spawn.position, PLAYER_VIEW_HALF_ANGLE)) return false;
      chest.copy(spawn.position);
      chest.y += BODY.chestStand;
      return world.lineOfSight(eye, chest);
    });
    const picks = assignSpawns(count, order, SPAWN_CAPACITY);
    const roles = assignRoles(picks.length);
    const used = new Map<number, number>();
    picks.forEach((spawnIndex, i) => {
      const spawn = map.enemySpawns[spawnIndex];
      if (!spawn) return;
      const slot = used.get(spawnIndex) ?? 0;
      used.set(spawnIndex, slot + 1);
      // The first soldier stands on the spawn; the rest take places around it.
      const angle = slot * 2.4;
      const radius = slot === 0 ? 0 : SPAWN_RING + 0.45 * Math.floor((slot - 1) / 5);
      const x = spawn.position.x + Math.cos(angle) * radius;
      const z = spawn.position.z + Math.sin(angle) * radius;
      const node = grid.nearestNode(x, spawn.position.y, z);
      if (node >= 0) chest.set(grid.nodeX(node), (grid.nodeY[node] ?? spawn.position.y) + 0.02, grid.nodeZ(node));
      else chest.copy(spawn.position);

      const visual = this.pool.get(team)?.pop() ?? createSoldier(this.ctx.assets, team);
      visual.revive();
      const id = this.ctx.combat.allocateId();
      const bot = new Bot(this, id, team, botName(this.spawned++), roles[i] ?? 'rifleman', difficulty, visual, chest, spawn.yaw);
      // Spread the first decisions so the squad does not think in the same frame.
      bot.thinkTimer = (this.bots.length % 7) * (THINK_INTERVAL / 7) + this.random() * THINK_INTERVAL * 0.5;
      bot.lastThink = this.time;
      bot.idleTimer = this.random() * 3;
      this.bots.push(bot);
      this.ctx.combat.add(bot);
      this.ctx.engine.scene.add(visual.root);
      this.ctx.events.emit('spawned', { combatantId: id });
    });
    this.sweepFrom = this.time;
    this.enemyTimer = 0;
  }

  update(dt: number): void {
    const queue = this.queue;
    if (!this.nav || !queue) return;
    const started = performance.now();
    const step = Math.min(dt, MAX_FRAME_SECONDS);
    this.time += step;

    this.enemyTimer -= step;
    if (this.enemyTimer <= 0) {
      this.enemyTimer = ENEMY_REFRESH_SECONDS;
      const team = this.bots[0]?.team;
      this.enemies = team ? this.ctx.combat.enemiesOf(team) : [];
    }
    this.squad.tally(this.bots);
    queue.update(PATH_BUDGET);
    const afterPaths = performance.now();

    // Decisions: a few soldiers per frame, starting where the last frame stopped.
    const bots = this.bots;
    const total = bots.length;
    let thinks = 0;
    for (let i = 0; i < total; i++) {
      const bot = bots[(this.thinkCursor + i) % total];
      if (!bot || !bot.alive) continue;
      bot.thinkTimer -= step;
      if (bot.thinkTimer > 0 || thinks >= MAX_THINKS_PER_FRAME) continue;
      thinks++;
      bot.thinkTimer = THINK_INTERVAL * (1 - THINK_JITTER / 2 + this.random() * THINK_JITTER);
      think(bot, this, Math.min(this.time - bot.lastThink, 0.5));
      bot.lastThink = this.time;
      this.squad.tally(bots);
    }
    if (total > 0) this.thinkCursor = (this.thinkCursor + 1) % total;
    const afterThinks = performance.now();

    for (let i = total - 1; i >= 0; i--) {
      const bot = bots[i];
      if (!bot) continue;
      bot.update(step);
      if (!bot.alive && bot.corpseTime > CORPSE_SECONDS) this.retire(i);
    }

    const finished = performance.now();
    this.record(afterPaths - started, afterThinks - afterPaths, finished - afterThinks);
    this.debug?.update(bots);
  }

  private record(pathMs: number, thinkMs: number, bodyMs: number): void {
    const stats = this.stats;
    const total = pathMs + thinkMs + bodyMs;
    const n = ++stats.frames;
    stats.updateMs += (total - stats.updateMs) / n;
    stats.pathMs += (pathMs - stats.pathMs) / n;
    stats.thinkMs += (thinkMs - stats.thinkMs) / n;
    stats.bodyMs += (bodyMs - stats.bodyMs) / n;
    stats.updateMaxMs = Math.max(stats.updateMaxMs, total);
    stats.pathMaxMs = Math.max(stats.pathMaxMs, pathMs);
    stats.thinkMaxMs = Math.max(stats.thinkMaxMs, thinkMs);
    stats.bodyMaxMs = Math.max(stats.bodyMaxMs, bodyMs);
    if (total > SLOW_FRAME_MS) stats.slowFrames++;
  }

  dispose(): void {
    this.leaveMap();
    for (const off of this.unsubscribe) off();
    for (const visuals of this.pool.values()) for (const visual of visuals) visual.dispose();
    this.pool.clear();
  }

  // ---------------------------------------------------------------- BotEnv

  sweepBias(bot: Bot): number {
    const quiet = this.time - Math.max(this.squad.contactTime, this.sweepFrom);
    const turn = this.bots.indexOf(bot) * SWEEP_STAGGER_SECONDS;
    return MathUtils.clamp((quiet - bot.profile.sweepDelay - turn) / SWEEP_RAMP_SECONDS, 0, 1);
  }

  callout(bot: Bot, kind: CalloutKind): void {
    if (!this.squad.tryCallout(kind, this.time)) return;
    calloutEvent.botId = bot.id;
    calloutEvent.kind = kind;
    calloutEvent.position.copy(bot.position);
    this.ctx.events.emit('botCallout', calloutEvent);
  }

  transition(bot: Bot, from: BotState, to: BotState, reason: string): void {
    this.debug?.transition(bot, from, to, reason, this.time);
  }

  // ---------------------------------------------------------------- hearing

  private onShot(event: GameEvents['shotFired']): void {
    const shooter = this.ctx.combat.get(event.shooterId);
    this.lastShotTeam = shooter ? shooter.team : null;
    this.lastMuzzle.copy(event.muzzle);
    if (!shooter) return;
    for (const bot of this.bots) {
      if (!bot.alive || bot.team === shooter.team) continue;
      const radius = hearingRadius('shot', event.weapon.loudness, bot.profile.hearingScale);
      if (bot.position.distanceToSquared(event.muzzle) < radius * radius) bot.hear('shot', event.muzzle);
    }
  }

  /** A bullet passing close by tells a soldier it is being shot at, and from where. */
  private onTrace(event: GameEvents['bulletTrace']): void {
    if (this.lastShotTeam === null) return;
    segment.subVectors(event.to, event.from);
    const lengthSq = segment.lengthSq();
    if (lengthSq < 1e-6) return;
    const radius = hearingRadius('nearMiss', 1, 1);
    for (const bot of this.bots) {
      if (!bot.alive || bot.team === this.lastShotTeam) continue;
      chest.copy(bot.position);
      chest.y += BODY.chestStand;
      const t = MathUtils.clamp(offset.subVectors(chest, event.from).dot(segment) / lengthSq, 0, 1);
      offset.copy(event.from).addScaledVector(segment, t);
      if (offset.distanceToSquared(chest) < radius * radius) bot.hear('nearMiss', this.lastMuzzle);
    }
  }

  private onImpact(event: GameEvents['bulletImpact']): void {
    if (this.lastShotTeam === null) return;
    for (const bot of this.bots) {
      if (!bot.alive || bot.team === this.lastShotTeam) continue;
      const radius = hearingRadius('impact', 1, bot.profile.hearingScale);
      if (bot.position.distanceToSquared(event.hit.point) < radius * radius) bot.hear('impact', this.lastMuzzle);
    }
  }

  private onFootstep(event: GameEvents['footstep']): void {
    if (!event.running || this.bots.length === 0) return;
    const owner = this.ctx.combat.get(event.ownerId);
    if (!owner) return;
    for (const bot of this.bots) {
      if (!bot.alive || bot.team === owner.team) continue;
      const radius = hearingRadius('footstep', 1, bot.profile.hearingScale);
      if (bot.position.distanceToSquared(event.position) < radius * radius) bot.hear('footstep', event.position);
    }
  }

  /** Take a bot out of the world and keep its body for the next one. */
  private retire(index: number): void {
    const bot = this.bots[index];
    if (!bot) return;
    this.bots.splice(index, 1);
    bot.halt();
    this.ctx.engine.scene.remove(bot.visual.root);
    this.ctx.combat.remove(bot.id);
    const visuals = this.pool.get(bot.team) ?? [];
    visuals.push(bot.visual);
    this.pool.set(bot.team, visuals);
  }
}
