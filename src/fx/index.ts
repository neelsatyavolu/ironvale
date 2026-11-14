import { visualsFrozen } from '../core/freeze';
import type { EffectsSystem, GameContext } from '../game/contracts';
import { Blood } from './blood';
import { Casings } from './casings';
import { Decals } from './decals';
import { GrenadeFx } from './grenade';
import { FxDemo } from './demo';
import { readDemoConfig } from './demo-config';
import { Impacts } from './impacts';
import { Muzzle } from './muzzle';
import { NearMiss } from './nearmiss';
import { ParticlePool } from './particles';
import { Rings } from './rings';
import { FxEnv, type FxModule } from './shared';
import { createSpriteSheet } from './textures';
import { Tracers } from './tracers';
import { WeatherFx } from './weather';

/** Lit particles: dust, debris, smoke, spray. Sized for sustained automatic fire at full density. */
const LIT_CAPACITY = 1536;
/** Additive particles: sparks and glints. */
const GLOW_CAPACITY = 640;

/**
 * Visual effects. Everything here reacts to `GameEvents`; no other system
 * calls it. Developer switches (`&fxdemo=`, `&fxweapon=`, `&fxslow=`) are
 * described in `demo-config.ts`.
 */
export function createEffects(ctx: GameContext): EffectsSystem {
  const config = readDemoConfig(typeof location === 'undefined' ? '' : location.search);
  const env = new FxEnv(ctx);
  const sprites = createSpriteSheet();
  const lit = new ParticlePool(env, { capacity: LIT_CAPACITY, additive: false, fadePower: 1.5, atlas: sprites });
  const glow = new ParticlePool(env, { capacity: GLOW_CAPACITY, additive: true, fadePower: 0.6, atlas: sprites });
  const rings = new Rings(env);
  const decals = new Decals(env);
  const tracers = new Tracers(env);
  const weather = new WeatherFx(env, lit, rings, sprites, config.weather);

  // Emitters first, then the pools they feed, so anything born this frame is uploaded this frame.
  const modules: readonly FxModule[] = [
    ...(config.names.size > 0 ? [new FxDemo(env, config)] : []),
    new Muzzle(env, lit),
    new Impacts(env, lit, glow, rings, decals),
    new Blood(env, lit),
    new Casings(env),
    new NearMiss(env, tracers, lit),
    new GrenadeFx(env, lit, glow, rings, decals),
    weather,
    decals,
    tracers,
  ];

  // With a demo on, the pools are reachable from the console: scene child 'fx', userData.pools.
  if (config.names.size > 0) env.root.userData.pools = { lit, glow, rings };

  let mapLoaded = false;
  let drivenByGame = false;

  const update = (dt: number): void => {
    const step = visualsFrozen ? 0 : dt * config.timeScale;
    env.advance(step);
    for (const module of modules) module.update(step);
    lit.flush();
    glow.flush();
    rings.flush();
  };

  // The game only updates effects while a match is being played. With a demo on, keep them
  // running when it is not (a match with no bots is won at once), so screenshots still work.
  const stopDemoDriver =
    config.names.size > 0 || config.weather !== null
      ? ctx.engine.onFrame((dt) => {
          if (mapLoaded && !drivenByGame) update(dt);
          drivenByGame = false;
        })
      : null;

  return {
    enterMap(map) {
      env.setMap(map.lighting, weather.weatherFor(map));
      for (const module of modules) module.enterMap?.(map);
      mapLoaded = true;
    },
    leaveMap() {
      mapLoaded = false;
      env.live = false;
      for (const module of modules) module.clear();
      lit.clear();
      glow.clear();
      rings.clear();
    },
    update(dt) {
      drivenByGame = true;
      update(dt);
    },
    dispose() {
      stopDemoDriver?.();
      for (const module of modules) module.dispose();
      lit.dispose();
      glow.dispose();
      rings.dispose();
      sprites.dispose();
      env.dispose();
    },
  };
}
