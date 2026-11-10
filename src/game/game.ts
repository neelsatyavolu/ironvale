import { Vector3, type Object3D } from 'three/webgpu';
import { createBots } from '../ai/index';
import { soldierAssets } from '../characters/index';
import { createAudio } from '../audio/index';
import { Assets } from '../core/assets';
import { EventBus } from '../core/events';
import { Input } from '../core/input';
import { hashString, seededRandom } from '../core/random';
import { SettingsStore } from '../core/settings';
import { createEffects } from '../fx/index';
import { loadMapModule, PLAYABLE_MAPS } from '../maps/registry';
import { createNet, type NetSystem } from '../net/index';
import { duelResult } from '../net/rules';
import { PlayerController } from '../player/controller';
import { Engine } from '../render/engine';
import { createInterface, type Interface } from '../ui/index';
import { WEAPON_DEFS } from '../weapons/defs';
import { createBallistics, createPlayerWeapons, weaponAssets } from '../weapons/index';
import { CollisionWorld } from '../world/collision';
import type { MapInstance, World } from '../world/types';
import { Combat } from './combat';
import type {
  AudioSystem,
  Ballistics,
  BotSystem,
  EffectsSystem,
  GameCommands,
  GameContext,
  GameEvents,
  KillFeedEntry,
  MatchConfig,
  MatchPhase,
  MatchSnapshot,
  PlayerWeapons,
} from './contracts';

const PLAYER_LIVES = 3;
const WIN_DELAY_SECONDS = 3.5;
const DEFAULT_INTERIOR_SKY_LIGHT = 0.45;
const RESPAWN_SECONDS = 3;
const SNAPSHOT_INTERVAL = 1 / 20;
const KILL_FEED_SECONDS = 6;
const SURVIVAL_WAVE_GROWTH = 2;
const SURVIVAL_WAVE_PAUSE = 5;
const DEFAULT_KILL_TARGET = 10;

/**
 * Let go of an unloaded map's scene graph. `map.dispose()` frees what the map owns, but props cloned
 * from cached models share geometry and materials it must not dispose, and the renderer keeps a draw
 * record for every mesh until the mesh, its geometry or its material is disposed. A dispose event on
 * each object releases those records; cutting the parent links means anything the renderer still
 * holds (a lamp in a cached shader, say) keeps only itself alive, not the whole map.
 */
function releaseObjects(root: Object3D): void {
  const objects: Object3D[] = [];
  root.traverse((object) => objects.push(object));
  for (const object of objects) {
    (object as { dispatchEvent(event: { type: string }): void }).dispatchEvent({ type: 'dispose' });
    object.clear();
  }
}

/**
 * Top-level game: owns the context, runs the match loop and exposes the
 * commands the interface calls.
 */
export class Game implements GameContext, GameCommands {
  readonly events = new EventBus<GameEvents>();
  readonly combat: Combat;
  readonly player: PlayerController;
  readonly ballistics: Ballistics;
  readonly audio: AudioSystem;
  world: World = new CollisionWorld();
  map: MapInstance | null = null;
  time = 0;

  readonly weapons: PlayerWeapons;
  readonly effects: EffectsSystem;
  readonly bots: BotSystem;
  /** Two-player session. Idle unless a match with a friend is set up. */
  readonly net: NetSystem;
  /** Developer hook: let scripts drive the player without pointer lock. */
  debugControl = false;
  private readonly ui: Interface;
  private frozen = false;
  private phase: MatchPhase = 'menu';
  private config: MatchConfig | null = null;
  private loadingProgress = 0;
  private loadingLabel = '';
  private kills = 0;
  private deaths = 0;
  private shotsFired = 0;
  private shotsHit = 0;
  private wave = 0;
  private waveTimer = 0;
  private respawnTimer = 0;
  private snapshotTimer = 0;
  private killFeed: KillFeedEntry[] = [];
  private loadToken = 0;

  private constructor(
    readonly engine: Engine,
    readonly settings: SettingsStore,
    readonly input: Input,
    readonly assets: Assets,
  ) {
    this.combat = new Combat(() => this.world);
    this.player = new PlayerController({
      engine,
      input,
      settings,
      events: this.events,
      world: this.worldProxy(),
      id: this.combat.allocateId(),
      team: 'alpha',
      interiors: () => this.map?.interiors ?? [],
    });
    this.audio = createAudio(this);
    this.ballistics = createBallistics(this);
    this.weapons = createPlayerWeapons(this);
    this.effects = createEffects(this);
    this.bots = createBots(this);
    const game = this;
    this.net = createNet(this, {
      weapons: this.weapons,
      bots: this.bots,
      listMaps: () => this.listMaps(),
      startMatch: (config) => this.startMatch(config, true),
      endMatch: (result) => this.endMatch(result),
      waveStarted: () => this.reinforce(),
      takeOver: (enemies, wave) => this.takeOver(enemies, wave),
      get kills() {
        return game.kills;
      },
      get deaths() {
        return game.deaths;
      },
    });
    this.ui = createInterface(this, this);

    this.events.on('died', (event) => this.onDeath(event));
    this.events.on('bulletTrace', (event) => {
      if (event.shooterId === this.player.id) this.shotsFired++;
    });
    this.events.on('combatantHit', (event) => {
      if (event.attackerId === this.player.id) this.shotsHit++;
    });
    settings.subscribe((next, previous) => {
      if (next.graphics !== previous.graphics) engine.applyGraphics(next.graphics);
    });
    input.onLock((locked) => {
      if (!locked && this.phase === 'playing') this.pause();
    });
    engine.onFrame((dt) => this.frame(dt));
    engine.start();
    this.emitSnapshot();
  }

  /** `settings` lets developer tooling start from an unsaved configuration. */
  static async create(canvas: HTMLCanvasElement, settings = new SettingsStore()): Promise<Game> {
    const graphics = settings.value.graphics;
    const engine = await Engine.create(canvas, graphics);
    const input = new Input(canvas, () => settings.value.controls);
    // An 8k sky panorama costs about 180 MB of GPU memory; only the top tier keeps it whole.
    const skyWidth = graphics.tier === 'ultra' ? 8192 : 4096;
    const assets = new Assets(graphics.textures, graphics.anisotropy, skyWidth);
    return new Game(engine, settings, input, assets);
  }

  listMaps(): readonly { id: string; name: string; tagline: string; thumbnail?: string }[] {
    const maps = PLAYABLE_MAPS.map((map) => ({
      ...map,
      thumbnail: `${import.meta.env.BASE_URL}assets/thumbs/${map.id}.jpg`,
    }));
    // ?dev adds the test range to the menu.
    if (!new URLSearchParams(location.search).has('dev')) return maps;
    return [...maps, { id: 'range', name: 'Test Range', tagline: 'Developer test map' }];
  }

  /** `fromNet` is set by the two-player session; any other start is a solo match and ends a session. */
  async startMatch(config: MatchConfig, fromNet = false): Promise<void> {
    if (!fromNet) this.net.leave();
    const token = ++this.loadToken;
    this.unloadMap();
    this.config = config;
    this.setPhase('loading');
    try {
      this.progress(0.02, 'Reading map');
      const module = await loadMapModule(config.mapId);
      if (token !== this.loadToken) return;
      const world = new CollisionWorld();
      this.world = world;

      const botAssets = config.botCount > 0 || fromNet ? soldierAssets() : [];
      await this.assets.preload([...module.meta.assets, ...weaponAssets(), ...botAssets], (loaded, total) =>
        this.progress(0.05 + 0.6 * (loaded / total), 'Loading textures and models'),
      );
      if (token !== this.loadToken) return;

      this.progress(0.7, 'Building the level');
      const map = await module.build({
        assets: this.assets,
        world,
        detailDensity: this.settings.value.graphics.detailDensity,
        random: seededRandom(hashString(config.mapId)),
      });
      world.build();
      if (token !== this.loadToken) {
        map.dispose();
        return;
      }
      this.map = map;
      this.engine.scene.add(map.root);
      this.engine.setLighting(map.lighting, this.assets.hdri(map.lighting.hdri), this.assets.sky(map.lighting.hdri));

      // A finished match leaves audio paused; a new one starts it again.
      this.audio.setPaused(false);
      this.progress(0.8, 'Loading sound');
      await this.assets.preload(this.audio.requiredSounds(map));
      // A quit or a newer start has already unloaded this map: do not enter it anywhere else.
      if (token !== this.loadToken) return;
      await this.audio.enterMap(map);
      if (token !== this.loadToken) return;
      this.progress(0.9, 'Placing enemies');
      this.effects.enterMap(map);
      await this.bots.enterMap(map);
      if (token !== this.loadToken) return;

      this.kills = 0;
      this.deaths = 0;
      this.shotsFired = 0;
      this.shotsHit = 0;
      this.time = 0;
      this.killFeed = [];
      this.wave = this.rules === 'survival' ? 1 : 0;
      this.waveTimer = 0;
      this.combat.add(this.player);
      this.net.enterMap(map);
      this.spawnPlayer(true);
      this.weapons.resupply();
      // A co-op guest shows the host's enemies instead of running its own.
      if (this.net.authority) this.bots.spawn(config.botCount, 'bravo', config.difficulty);
      // Compile every shader while the loading screen is still up, so the first
      // seconds of play do not stutter.
      this.progress(0.95, 'Preparing the renderer');
      this.player.update(0);
      this.weapons.update(0);
      await this.engine.warmUp();
      if (token !== this.loadToken) return;
      this.progress(1, 'Ready');
      this.setPhase('playing');
      this.net.matchLoaded();
    } catch (error) {
      console.error('Could not start the match', error);
      // A load that was superseded must not tear down the one that replaced it.
      if (token !== this.loadToken) return;
      this.loadingLabel = error instanceof Error ? error.message : 'Could not load the map';
      this.unloadMap();
      this.setPhase('menu');
      throw error;
    }
  }

  resume(): void {
    if (this.phase !== 'paused') return;
    if (!this.net.inMatch) this.audio.setPaused(false);
    this.setPhase('playing');
  }

  pause(): void {
    if (this.phase !== 'playing') return;
    // With a friend connected the match goes on behind the pause menu.
    if (!this.net.inMatch) this.audio.setPaused(true);
    this.setPhase('paused');
  }

  async restart(): Promise<void> {
    // A two-player match is started again from its lobby, by the host.
    if (this.config && !this.net.inMatch) await this.startMatch(this.config);
  }

  quitToMenu(): void {
    this.loadToken++;
    this.unloadMap();
    this.config = null;
    this.input.exitLock();
    this.setPhase('menu');
  }

  dispose(): void {
    this.unloadMap();
    this.ui.dispose();
    this.net.dispose();
    this.bots.dispose();
    this.effects.dispose();
    this.audio.dispose();
    this.input.dispose();
    this.engine.dispose();
  }

  private frame(dt: number): void {
    const net = this.net;
    // A match with a friend keeps running while this player has the pause menu up.
    // Holding the weapon picker open stops the clock when playing alone.
    const choosing = this.phase === 'playing' && !net.inMatch && this.input.isDown('scores');
    const simulating = !choosing && (this.phase === 'playing' || (this.phase === 'paused' && net.inMatch));
    if (simulating) {
      const frozen = net.frozen;
      this.setFrozen(frozen);
      if (!frozen) this.time += dt;
      this.player.controllable = (this.input.locked || this.debugControl) && !frozen;
      this.player.update(dt);
      this.weapons.update(dt);
      this.player.setWeaponModifiers({
        mobility: this.weapons.current.def.mobility,
        aimBlend: this.weapons.aimBlend,
        zoom: this.weapons.zoom,
        blockSprint: this.weapons.blocksSprint,
      });
      if (!frozen) this.bots.update(dt);
      this.effects.update(dt);
      this.map?.update?.(dt, this.time, this.engine.camera.position);
      this.engine.setSkyLight(this.interiorSkyLight(), dt);
      if (!frozen) this.updateRules(dt);
      if (this.phase === 'playing' && this.input.wasPressed('pause')) this.pause();
    }
    net.update(dt, simulating);
    this.audio.update(dt);
    this.input.endFrame();

    this.snapshotTimer += dt;
    if (this.snapshotTimer >= SNAPSHOT_INTERVAL) {
      this.snapshotTimer = 0;
      this.emitSnapshot();
    }
  }

  /** The rules in force: a co-op match plays under Skirmish or Survival rules. */
  private get rules(): 'skirmish' | 'survival' | 'duel' {
    const config = this.config;
    if (!config) return 'skirmish';
    if (config.mode === 'coop') return config.rules ?? 'skirmish';
    return config.mode;
  }

  private updateRules(dt: number): void {
    const config = this.config;
    if (!config) return;
    const rules = this.rules;
    const net = this.net;

    if (rules === 'duel') {
      if (!this.player.alive) {
        this.respawnTimer -= dt;
        if (this.respawnTimer <= 0) this.spawnPlayer();
      }
      const result = duelResult(this.kills, this.deaths, config.killTarget ?? DEFAULT_KILL_TARGET);
      if (result) this.endMatch(result);
      return;
    }

    // With a partner still in the fight the match goes on while this player is down.
    const partner = net.partner;
    const partnerStanding = partner !== null && (partner.alive || (rules === 'skirmish' && partner.deaths < PLAYER_LIVES));
    if (!this.player.alive) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) {
        const outOfLives = rules === 'survival' || this.deaths >= PLAYER_LIVES;
        if (!outOfLives) this.spawnPlayer();
        else if (!partnerStanding && net.authority) this.endMatch('lost');
      }
      if (!partnerStanding) return;
    }
    // A co-op guest leaves waves and the result to the host.
    if (!net.authority) return;

    // A match with no enemies is a sandbox: nothing to win.
    if (this.bots.alive > 0 || config.botCount === 0) return;
    if (rules === 'survival') {
      this.waveTimer += dt;
      if (this.waveTimer < SURVIVAL_WAVE_PAUSE) return;
      this.waveTimer = 0;
      this.wave++;
      this.reinforce();
      this.bots.spawn(config.botCount + (this.wave - 1) * SURVIVAL_WAVE_GROWTH, 'bravo', config.difficulty);
    } else if (this.kills + net.partnerKills >= config.botCount) {
      // Let the last kill land and be seen before the result screen comes up.
      this.waveTimer += dt;
      if (this.waveTimer >= WIN_DELAY_SECONDS) this.endMatch('won');
    }
  }

  private endMatch(result: 'won' | 'lost'): void {
    if (this.phase !== 'playing' && this.phase !== 'paused') return;
    this.net.reportMatch(this.wave, this.bots.alive, result, this.kills);
    this.setFrozen(false);
    this.input.exitLock();
    this.audio.setPaused(true);
    this.setPhase(result);
  }

  /** A new wave: fresh ammunition, and in co-op Survival a fallen player rejoins. */
  private reinforce(): void {
    this.weapons.resupply();
    if (!this.player.alive && this.config?.mode === 'coop' && this.rules === 'survival') this.spawnPlayer();
  }

  /** Co-op guest whose host has gone: run the remaining enemies here and carry on alone. */
  private takeOver(enemies: number, wave: number): void {
    const config = this.config;
    if (!config) return;
    this.wave = Math.max(this.wave, wave);
    this.waveTimer = 0;
    this.bots.spawn(enemies, 'bravo', config.difficulty);
  }

  /**
   * While a two-player match counts down nobody may shoot: the weapons read a
   * scripted input with nothing pressed instead of the mouse and keys.
   */
  private setFrozen(frozen: boolean): void {
    if (frozen === this.frozen) return;
    this.frozen = frozen;
    (this.weapons as PlayerWeapons & { debugInput?: object | null }).debugInput = frozen ? {} : null;
  }

  private onDeath(event: GameEvents['died']): void {
    const victim = this.combat.get(event.victimId);
    const killer = this.combat.get(event.killerId);
    this.killFeed = [
      ...this.killFeed,
      {
        killer: killer?.name ?? 'Unknown',
        victim: victim?.name ?? 'Unknown',
        weapon: (WEAPON_DEFS as Record<string, { name: string } | undefined>)[event.weaponId]?.name ?? event.weaponId,
        headshot: event.headshot,
        time: this.time,
      },
    ].slice(-5);
    if (event.victimId === this.player.id) {
      this.deaths++;
      this.respawnTimer = RESPAWN_SECONDS;
    } else if (event.killerId === this.player.id) {
      this.kills++;
    }
    this.emitSnapshot();
  }

  private spawnPlayer(initial = false): void {
    const map = this.map;
    if (!map) return;
    const enemies = this.combat.enemiesOf(this.player.team);
    // A two-player match may place the player itself. Otherwise pick the spawn furthest from the nearest enemy.
    let best = this.net.pickSpawn(map, initial) ?? map.playerSpawns[0];
    let bestScore = best === map.playerSpawns[0] ? -Infinity : Infinity;
    for (const spawn of map.playerSpawns) {
      const nearest = enemies.reduce((min, e) => Math.min(min, e.position.distanceTo(spawn.position)), Infinity);
      if (nearest > bestScore) {
        bestScore = nearest;
        best = spawn;
      }
    }
    if (!best) throw new Error('Map has no player spawns');
    this.player.respawn(best.position, best.yaw);
    this.weapons.resupply();
  }

  private unloadMap(): void {
    const map = this.map;
    this.setFrozen(false);
    this.net.leaveMap();
    this.combat.clear();
    if (!map) return;
    this.bots.leaveMap();
    this.effects.leaveMap();
    this.audio.leaveMap();
    this.engine.scene.remove(map.root);
    map.dispose();
    releaseObjects(map.root);
    this.map = null;
  }

  /** Sky light reaching the player: 1 outdoors, the zone's value inside an interior. */
  private interiorSkyLight(): number {
    const zones = this.map?.interiors;
    if (!zones || !this.player.indoors) return 1;
    const eye = this.engine.camera.position;
    for (const zone of zones) {
      if (zone.box.containsPoint(eye)) return zone.skyLight ?? DEFAULT_INTERIOR_SKY_LIGHT;
    }
    return 1;
  }

  /** The player keeps one World reference for its lifetime; forward to whichever map is loaded. */
  private worldProxy(): World {
    const game = this;
    return {
      addCollider: (g, m, s) => game.world.addCollider(g, m, s),
      addColliderObject: (r, s) => game.world.addColliderObject(r, s),
      addBoundary: (g, m) => game.world.addBoundary(g, m),
      build: () => game.world.build(),
      raycast: (o, d, max) => game.world.raycast(o, d, max),
      lineOfSight: (a, b) => game.world.lineOfSight(a, b),
      moveCapsule: (p, v, dt, r, h) => game.world.moveCapsule(p, v, dt, r, h),
      groundHeight: (x, z, y, drop) => game.world.groundHeight(x, z, y, drop),
      capsuleFits: (p, r, h) => game.world.capsuleFits(p, r, h),
      get bounds() {
        return game.world.bounds;
      },
    };
  }

  private progress(value: number, label: string): void {
    this.loadingProgress = value;
    this.loadingLabel = label;
    this.emitSnapshot();
  }

  private setPhase(phase: MatchPhase): void {
    this.phase = phase;
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    const weapon = this.weapons.current;
    const net = this.net;
    const hostMatch = net.hostMatch;
    if (this.phase === 'playing' || this.phase === 'paused') net.reportMatch(this.wave, this.bots.alive, '', this.kills);
    const snapshot: MatchSnapshot = {
      phase: this.phase,
      config: this.config,
      loadingProgress: this.loadingProgress,
      loadingLabel: this.loadingLabel,
      health: Math.round(this.player.health),
      weaponName: weapon.def.name,
      fireMode: weapon.def.fireMode,
      magazine: weapon.magazine,
      reserve: weapon.reserve,
      reloading: weapon.reloading,
      scopedIn: this.weapons.scopedIn,
      aiming: this.weapons.aimBlend > 0.5,
      livesRemaining: this.rules === 'skirmish' ? Math.max(0, PLAYER_LIVES - this.deaths) : 1,
      respawnIn: this.player.alive ? 0 : Math.max(0, this.respawnTimer),
      shotsFired: this.shotsFired,
      shotsHit: this.shotsHit,
      kills: this.kills,
      deaths: this.deaths,
      enemiesRemaining: hostMatch?.enemies ?? this.bots.alive,
      wave: hostMatch?.wave ?? this.wave,
      elapsed: this.time,
      killFeed: this.killFeed.filter((entry) => this.time - entry.time < KILL_FEED_SECONDS),
      net: net.snapshot(),
    };
    this.events.emit('matchState', snapshot);
  }

  /** Developer hook: place the camera for screenshots. */
  debugPose(x: number, y: number, z: number, yaw: number, pitch: number): void {
    this.player.respawn(new Vector3(x, y, z), yaw);
    this.player.pitch = pitch;
    this.player.update(0);
  }
}
