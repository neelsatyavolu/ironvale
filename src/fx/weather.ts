import * as THREE from 'three/webgpu';
import type { InteriorZone, MapInstance, Weather } from '../world/types';
import { FogBanks, Motes } from './mist';
import type { ParticlePool } from './particles';
import { Rain } from './rain';
import type { Rings } from './rings';
import { RoofMask, STALE_HEIGHT } from './roof-mask';
import { randRange, type FxEnv, type FxModule } from './shared';
import { SPRITE } from './textures';

/** The roof mask covers a square this many cells across around the player. */
const MASK_CELLS = 32;
const MASK_CELL_METRES = 1;
/** Mask cells probed per frame while the player walks. A respawn refreshes everything at once. */
const MASK_BUDGET = 48;
const MASK_FULL_REFRESH = (MASK_CELLS * MASK_CELLS) / 2;
/** Height reported where there is nothing under a cell at all. */
const NO_GROUND = -1000;
/** Rain rings landing around the player per second at full detail. */
const SPLASHES_PER_SECOND = 420;
const SPLASH_MIN_RADIUS = 1.2;
const SPLASH_MAX_RADIUS = 10;
/** Splashes land mostly inside this half-angle of where the player is looking. */
const SPLASH_VIEW_HALF_ANGLE = 1.25;
const SPLASH_IN_VIEW_SHARE = 0.8;
/** A surface this far above the player's feet is a roof; splashes on it would not be seen. */
const ROOF_ABOVE_FEET = 2.6;
const MAX_SPLASHES_PER_FRAME = 16;
/** Share of the dust motes each kind of weather shows. */
const MOTE_AMOUNT: Readonly<Record<Weather, number>> = { clear: 0.3, mist: 1, rain: 0 };
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Rain, ground mist and dust motes for the map's weather, plus the roof mask
 * that keeps them out from under cover.
 */
export class WeatherFx implements FxModule {
  private readonly mask = new RoofMask(MASK_CELLS, MASK_CELL_METRES);
  private readonly maskData = new Uint16Array(MASK_CELLS * MASK_CELLS);
  private readonly maskTexture: THREE.DataTexture;
  private maskVersion = -1;
  private readonly rain: Rain;
  private readonly banks: FogBanks;
  private readonly motes: Motes;
  private weather: Weather = 'clear';
  private interiors: readonly InteriorZone[] = [];
  private active = false;
  private splashDebt = 0;
  private readonly point = new THREE.Vector3();
  private readonly splashLight = new THREE.Color();

  constructor(
    private readonly env: FxEnv,
    private readonly lit: ParticlePool,
    private readonly rings: Rings,
    atlas: THREE.Texture,
    private readonly weatherOverride: Weather | null,
  ) {
    this.maskData.fill(THREE.DataUtils.toHalfFloat(STALE_HEIGHT));
    this.maskTexture = new THREE.DataTexture(this.maskData, MASK_CELLS, MASK_CELLS, THREE.RedFormat, THREE.HalfFloatType);
    this.maskTexture.wrapS = THREE.RepeatWrapping;
    this.maskTexture.wrapT = THREE.RepeatWrapping;
    this.maskTexture.minFilter = THREE.NearestFilter;
    this.maskTexture.magFilter = THREE.NearestFilter;
    this.maskTexture.needsUpdate = true;
    const maskRef = { texture: this.maskTexture, span: MASK_CELLS * MASK_CELL_METRES };
    this.rain = new Rain(env, maskRef);
    this.banks = new FogBanks(env, atlas);
    this.motes = new Motes(env, atlas, maskRef);
  }

  /** The weather effects run for; a developer override wins over the map's own. */
  weatherFor(map: MapInstance): Weather {
    return this.weatherOverride ?? map.weather;
  }

  enterMap(map: MapInstance): void {
    this.weather = this.weatherFor(map);
    this.interiors = map.interiors;
    this.active = true;
    this.splashDebt = 0;
    this.rain.setActive(this.weather === 'rain');
    this.banks.setActive(this.weather === 'mist');
    this.motes.setAmount(MOTE_AMOUNT[this.weather]);
  }

  update(dt: number): void {
    if (!this.active) return;
    this.refreshMask();
    this.rain.update(dt);
    this.banks.update(dt);
    this.motes.update();
    if (this.weather === 'rain') this.splashes(dt);
  }

  clear(): void {
    this.active = false;
    this.rain.setActive(false);
    this.banks.setActive(false);
    this.motes.setAmount(0);
  }

  dispose(): void {
    this.rain.dispose();
    this.banks.dispose();
    this.motes.dispose();
    this.maskTexture.dispose();
  }

  /** Highest surface over a point: the level's own geometry, or the top of an interior zone that covers it. */
  private readonly probe = (x: number, z: number): number => {
    const world = this.env.ctx.world;
    const top = world.bounds.max.y + 1;
    const bottom = world.bounds.min.y - 1;
    let height = Number.isFinite(top) && top > bottom ? (world.groundHeight(x, z, top, top - bottom) ?? NO_GROUND) : NO_GROUND;
    for (const zone of this.interiors) {
      const box = zone.box;
      if (x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z) height = Math.max(height, box.max.y);
    }
    return height;
  };

  private refreshMask(): void {
    const position = this.env.ctx.player.position;
    this.mask.setCentre(position.x, position.z);
    if (this.mask.stale > 0) {
      this.mask.refresh(this.probe, this.mask.stale > MASK_FULL_REFRESH ? Infinity : MASK_BUDGET);
    }
    if (this.mask.version === this.maskVersion) return;
    this.maskVersion = this.mask.version;
    const heights = this.mask.heights;
    for (let i = 0; i < heights.length; i++) this.maskData[i] = THREE.DataUtils.toHalfFloat(heights[i]!);
    this.maskTexture.needsUpdate = true;
  }

  /** Rings and a speck of spray where drops land on open ground near the player. */
  private splashes(dt: number): void {
    const ctx = this.env.ctx;
    const player = ctx.player;
    this.splashDebt += SPLASHES_PER_SECOND * this.env.detailDensity * dt;
    let budget = MAX_SPLASHES_PER_FRAME;
    const light = this.env.shade(0.8, 0.86, 0.92, 0, this.splashLight);
    while (this.splashDebt >= 1 && budget-- > 0) {
      this.splashDebt -= 1;
      const inView = Math.random() < SPLASH_IN_VIEW_SHARE;
      const angle = inView ? player.yaw + randRange(-SPLASH_VIEW_HALF_ANGLE, SPLASH_VIEW_HALF_ANGLE) : randRange(0, Math.PI * 2);
      const radius = SPLASH_MIN_RADIUS + (SPLASH_MAX_RADIUS - SPLASH_MIN_RADIUS) * Math.sqrt(Math.random());
      // Yaw 0 looks down -Z.
      const x = player.position.x - Math.sin(angle) * radius;
      const z = player.position.z - Math.cos(angle) * radius;
      const cover = this.mask.heightAt(x, z);
      if (cover === STALE_HEIGHT || cover <= NO_GROUND || cover > player.position.y + ROOF_ABOVE_FEET) continue;
      const ground = ctx.world.groundHeight(x, z, cover + 0.5, 2);
      if (ground === null) continue;
      this.point.set(x, ground, z);
      this.rings.add(this.point, UP, 0.03, randRange(0.13, 0.24), randRange(0.2, 0.32), 0.55, 0);

      const s = this.lit.spawn;
      s.x = x;
      s.y = ground + 0.02;
      s.z = z;
      s.vx = 0;
      s.vy = 0.5;
      s.vz = 0;
      s.life = 0.16;
      s.size = 0.025;
      s.sizeEnd = 0.085;
      s.rotation = randRange(-0.3, 0.3);
      s.spin = 0;
      s.r = light.r * 1.4;
      s.g = light.g * 1.4;
      s.b = light.b * 1.4;
      s.a = 0.5;
      s.sprite = SPRITE.splash;
      s.gravity = 0;
      s.drag = 2;
      s.stretch = 0;
      this.lit.emit();
    }
    if (this.splashDebt > MAX_SPLASHES_PER_FRAME) this.splashDebt = 0;
  }
}
