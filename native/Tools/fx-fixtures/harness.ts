/**
 * Runs the real src/fx modules headless (no renderer) and reads back what they wrote for the GPU.
 *
 * The modules are built exactly as createEffects (src/fx/index.ts) builds them, minus the dev demo,
 * against a stub GameContext: the camera, the player, settings and the event bus are plain objects,
 * the world is a real CollisionWorld. Canvas2D sheets are drawn into a no-op canvas (their pixels are
 * baked separately in Chrome, bake-atlases.mjs). Math.random is replaced by mulberry32 for the run,
 * so the Swift port, consuming the same stream in the same order, must write the same buffers.
 */
import * as THREE from 'three/webgpu';
import { EventBus } from '../../../src/core/events';
import { seededRandom } from '../../../src/core/random';
import type { GameEvents } from '../../../src/game/contracts';
import { Blood } from '../../../src/fx/blood';
import { Casings } from '../../../src/fx/casings';
import { Decals } from '../../../src/fx/decals';
import { GrenadeFx } from '../../../src/fx/grenade';
import { Impacts } from '../../../src/fx/impacts';
import { Muzzle } from '../../../src/fx/muzzle';
import { NearMiss } from '../../../src/fx/nearmiss';
import { ParticlePool } from '../../../src/fx/particles';
import { Rings } from '../../../src/fx/rings';
import { FxEnv, type FxModule } from '../../../src/fx/shared';
import { Tracers } from '../../../src/fx/tracers';
import { WeatherFx } from '../../../src/fx/weather';
import { WEAPON_DEFS } from '../../../src/weapons/defs';
import type { CollisionWorld } from '../../../src/world/collision';
import type { Surface, Weather } from '../../../src/world/types';

/** A Canvas2D context that accepts every call and draws nothing. */
function installFakeCanvas(): void {
  const gradient = { addColorStop: () => undefined };
  const ctx = new Proxy(
    {},
    {
      get: (_t, key) => {
        if (key === 'createRadialGradient' || key === 'createLinearGradient') return () => gradient;
        if (key === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
        if (key === 'createImageData') return (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
        return () => undefined;
      },
      set: () => true,
    },
  );
  const g = globalThis as unknown as { document?: unknown };
  g.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
}

export interface SceneLighting {
  sunDirection: [number, number, number];
  sunColor: number;
  sunIntensity: number;
  skyIntensity: number;
  fogColor: number;
}

export interface ScenePose {
  /** Camera position and yaw/pitch (radians, YXZ as the player sets it). */
  eye: [number, number, number];
  yaw: number;
  pitch: number;
}

export interface FixtureEvent {
  type: 'shotFired' | 'bulletTrace' | 'bulletImpact' | 'combatantHit' | 'nearMiss' | 'casingEjected' | 'grenadeExploded';
  /** Weapon id plus overrides of the fields the effects read. */
  weapon?: { id: string; weaponClass?: string; pellets?: number; muzzleVelocity?: number };
  local?: boolean;
  a?: [number, number, number];
  b?: [number, number, number];
  normal?: [number, number, number];
  surface?: Surface;
  kind?: 'pistol' | 'rifle' | 'shotgun';
  targetId?: number;
  fatal?: boolean;
}

export interface SceneStep {
  dt: number;
  events: FixtureEvent[];
  /** Optional camera move before this step's events. */
  pose?: ScenePose;
  /** Optional player move (feet), for weather. */
  feet?: [number, number, number];
  indoors?: boolean;
  /** The grenade being aimed this step (hand origin and throw velocity), or absent for none. */
  aim?: { origin: [number, number, number]; velocity: [number, number, number] };
}

export interface Scene {
  name: string;
  seed: number;
  weather: Weather;
  particleDensity: number;
  detailDensity: number;
  lighting: SceneLighting;
  pose: ScenePose;
  feet: [number, number, number];
  interiors: { min: [number, number, number]; max: [number, number, number] }[];
  steps: SceneStep[];
}

const PLAYER_ID = 0;

/** Non-zero rows of a strided float buffer: [slot, ...values]. */
function rows(data: ArrayLike<number>, stride: number): number[][] {
  const out: number[][] = [];
  for (let slot = 0; slot * stride < data.length; slot++) {
    const row = Array.from({ length: stride }, (_, i) => data[slot * stride + i]!);
    if (row.some((v) => v !== 0)) out.push([slot, ...row]);
  }
  return out;
}

function v3(a: [number, number, number] | undefined): THREE.Vector3 {
  return new THREE.Vector3(...(a ?? [0, 0, 0]));
}

export function runScene(scene: Scene, world: CollisionWorld): unknown {
  installFakeCanvas();
  // Building three objects draws uuids from Math.random, so the seeded stream starts once the
  // modules exist (arm()); only the effects' own draws are part of the fixture.
  let random: (() => number) | null = null;
  let draws = 0;
  const savedRandom = Math.random;
  Math.random = () => {
    if (!random) return savedRandom();
    draws++;
    return random();
  };
  try {
    return run(scene, world, () => draws, () => (random = seededRandom(scene.seed)));
  } finally {
    Math.random = savedRandom;
  }
}

function run(scene: Scene, world: CollisionWorld, draws: () => number, arm: () => void): unknown {
  const camera = new THREE.PerspectiveCamera(78, 1.6, 0.04, 900);
  camera.rotation.order = 'YXZ';
  const scenegraph = new THREE.Scene();
  const events = new EventBus<GameEvents>();
  const player = { id: PLAYER_ID, indoors: false, position: v3(scene.feet), yaw: scene.pose.yaw, alive: true };
  const setPose = (pose: ScenePose): void => {
    camera.position.set(...pose.eye);
    camera.rotation.set(pose.pitch, pose.yaw, 0, 'YXZ');
    camera.updateMatrixWorld(true);
    player.yaw = pose.yaw;
  };
  let pose = scene.pose;
  setPose(pose);
  const ctx = {
    engine: { scene: scenegraph, camera },
    events,
    world,
    player,
    settings: {
      value: {
        graphics: { particleDensity: scene.particleDensity, detailDensity: scene.detailDensity },
        gameplay: { headBob: 1 },
      },
    },
    weapons: { grenade: { aiming: false, origin: new THREE.Vector3(), velocity: new THREE.Vector3() } },
    grenades: { flights: [] },
  };
  const env = new FxEnv(ctx as never);
  const atlas = new THREE.Texture();
  const lit = new ParticlePool(env, { capacity: 1536, additive: false, fadePower: 1.5, atlas });
  const glow = new ParticlePool(env, { capacity: 640, additive: true, fadePower: 0.6, atlas });
  const rings = new Rings(env);
  const decals = new Decals(env);
  const tracers = new Tracers(env);
  const weather = new WeatherFx(env, lit, rings, atlas, null);
  const muzzle = new Muzzle(env, lit);
  const casings = new Casings(env);
  const grenade = new GrenadeFx(env, lit, glow, rings, decals);
  const modules: FxModule[] = [
    muzzle,
    new Impacts(env, lit, glow, rings, decals),
    new Blood(env, lit),
    casings,
    new NearMiss(env, tracers, lit),
    grenade,
    weather,
    decals,
    tracers,
  ];
  const landed: unknown[] = [];
  events.on('casingLanded', (e) => landed.push({ kind: e.kind, position: e.position.toArray(), surface: e.surface }));

  const lighting = scene.lighting;
  const interiors = scene.interiors.map((z) => ({ box: new THREE.Box3(v3(z.min), v3(z.max)), reverb: 'interior' as const }));
  const map = {
    weather: scene.weather,
    interiors,
    lighting: {
      sunDirection: v3(lighting.sunDirection),
      sunColor: lighting.sunColor,
      sunIntensity: lighting.sunIntensity,
      skyIntensity: lighting.skyIntensity,
      fog: { color: lighting.fogColor },
    },
  };
  env.setMap(map.lighting as never, weather.weatherFor(map as never));
  for (const m of modules) m.enterMap?.(map as never);
  arm();

  const weaponOf = (w: FixtureEvent['weapon']) => ({ ...WEAPON_DEFS[(w?.id ?? 'm4a1') as keyof typeof WEAPON_DEFS], ...(w ?? {}) });
  const emit = (e: FixtureEvent): void => {
    const weapon = weaponOf(e.weapon) as never;
    const local = e.local ?? false;
    switch (e.type) {
      case 'shotFired':
        events.emit('shotFired', { shooterId: local ? PLAYER_ID : 7, weapon, muzzle: v3(e.a), direction: v3(e.b), local });
        break;
      case 'bulletTrace':
        events.emit('bulletTrace', { shooterId: local ? PLAYER_ID : 7, weapon, from: v3(e.a), to: v3(e.b), local });
        break;
      case 'bulletImpact':
        events.emit('bulletImpact', {
          shooterId: 7,
          weapon,
          hit: { point: v3(e.a), normal: v3(e.normal), distance: 10, surface: e.surface ?? 'concrete' } as never,
        });
        break;
      case 'combatantHit':
        events.emit('combatantHit', {
          weapon,
          targetId: e.targetId ?? 3,
          attackerId: 7,
          hit: { point: v3(e.a), distance: 10, zone: 'torso' } as never,
          direction: v3(e.b),
          fatal: e.fatal ?? false,
        });
        break;
      case 'nearMiss':
        events.emit('nearMiss', { point: v3(e.a), direction: v3(e.b), weapon });
        break;
      case 'casingEjected':
        events.emit('casingEjected', { kind: e.kind ?? 'rifle', position: v3(e.a), velocity: v3(e.b) });
        break;
      case 'grenadeExploded':
        events.emit('grenadeExploded', { ownerId: 7, position: v3(e.a), local });
        break;
    }
  };

  const internal = <T>(o: object, key: string): T => (o as Record<string, T>)[key]!;
  const snapshot = () => {
    const muzzleMesh = internal<THREE.InstancedMesh>(muzzle, 'mesh');
    const decalMesh = internal<THREE.InstancedMesh>(decals, 'mesh');
    const casingMesh = internal<THREE.InstancedMesh>(casings, 'mesh');
    const lights = internal<{ light: THREE.PointLight; birth: number; peak: number }[]>(muzzle, 'lights');
    const rain = internal<object>(weather, 'rain');
    const banks = internal<object>(weather, 'banks');
    const motes = internal<object>(weather, 'motes');
    const uniform = (o: object, k: string) => {
      const v = internal<{ value: THREE.Vector3 | number }>(o, k).value;
      return typeof v === 'number' ? v : v.toArray();
    };
    return {
      now: env.now,
      draws: draws(),
      lit: rows(internal<Float32Array>(lit, 'data'), 20),
      glow: rows(internal<Float32Array>(glow, 'data'), 20),
      rings: rows(internal<Float32Array>(rings, 'data'), 12),
      tracers: rows(internal<Float32Array>(tracers, 'data'), 12),
      decalMatrices: rows(decalMesh.instanceMatrix.array, 16),
      decalInfo: rows(internal<THREE.InstancedBufferAttribute>(decals, 'info').array, 4),
      flashMatrices: rows(muzzleMesh.instanceMatrix.array, 16),
      flashInfo: rows(internal<THREE.InstancedBufferAttribute>(muzzle, 'info').array, 2),
      lights: lights.map((l) => [l.light.intensity, ...l.light.position.toArray()]),
      heat: internal<number>(muzzle, 'heat'),
      casingMatrices: rows(casingMesh.instanceMatrix.array, 16),
      casingHull: rows(internal<THREE.InstancedBufferAttribute>(casings, 'hull').array, 1),
      landed: landed.splice(0),
      shake: [camera.rotation.x - pose.pitch, camera.rotation.y - pose.yaw, camera.rotation.z, camera.position.y - pose.eye[1]],
      rain: { visible: internal<THREE.Mesh>(rain, 'mesh').visible, count: internal<THREE.Mesh>(rain, 'mesh').count, centre: uniform(rain, 'centre'), fall: uniform(rain, 'fall'), indoors: uniform(rain, 'indoors') },
      banks: { visible: internal<THREE.Mesh>(banks, 'mesh').visible, count: internal<THREE.Mesh>(banks, 'mesh').count, centre: uniform(banks, 'centre'), indoors: uniform(banks, 'indoors') },
      motes: { visible: internal<THREE.Mesh>(motes, 'mesh').visible, count: internal<THREE.Mesh>(motes, 'mesh').count, centre: uniform(motes, 'centre') },
      mask: Array.from(internal<{ heights: Float32Array }>(weather, 'mask').heights),
      arc: arcState(),
    };
  };

  // Each frame keeps only what changed since the previous one: rows by slot, other values when different.
  const arcState = () => {
    const arc = internal<object>(grenade, 'arc');
    const ribbon = internal<THREE.Mesh>(arc, 'ribbon');
    const marker = internal<THREE.Mesh>(arc, 'marker');
    const used = Math.max(0, internal<number>(arc, 'count') - 2);
    return {
      count: internal<number>(arc, 'count'),
      ribbonVisible: ribbon.visible,
      markerVisible: marker.visible,
      drawCount: ribbon.geometry.drawRange.count,
      positions: Array.from(internal<Float32Array>(arc, 'positions').subarray(0, used * 6)),
      marker: [...marker.position.toArray(), marker.scale.x],
    };
  };
  const frames: unknown[] = [];
  let previous: Record<string, unknown> = {};
  const diff = (now: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(now)) {
      const before = previous[key];
      if (Array.isArray(value) && value.length > 0 && Array.isArray(value[0]) && key !== 'lights' && key !== 'landed') {
        const old = new Map(((before as number[][] | undefined) ?? []).map((r) => [r[0], JSON.stringify(r)]));
        const fresh = new Set((value as number[][]).map((r) => r[0]));
        const changed = (value as number[][]).filter((r) => old.get(r[0]) !== JSON.stringify(r));
        const width = (value as number[][])[0]!.length - 1;
        const cleared = [...old.keys()].filter((slot) => !fresh.has(slot)).map((slot) => [slot!, ...new Array<number>(width).fill(0)]);
        out[key] = [...changed, ...cleared].sort((a, b) => a[0]! - b[0]!);
      } else if (Array.isArray(value) && value.length === 0 && Array.isArray(before) && before.length > 0 && Array.isArray(before[0]) && key !== 'landed') {
        out[key] = (before as number[][]).map((r) => [r[0]!, ...new Array<number>(r.length - 1).fill(0)]);
      } else if (key === 'landed' || JSON.stringify(value) !== JSON.stringify(before)) {
        out[key] = value;
      }
    }
    previous = now;
    return out;
  };
  for (const step of scene.steps) {
    if (step.pose) pose = step.pose;
    setPose(pose);
    if (step.feet) player.position.set(...step.feet);
    if (step.indoors !== undefined) player.indoors = step.indoors;
    ctx.weapons.grenade.aiming = step.aim !== undefined;
    if (step.aim) {
      ctx.weapons.grenade.origin.set(...step.aim.origin);
      ctx.weapons.grenade.velocity.set(...step.aim.velocity);
    }
    for (const e of step.events) emit(e);
    // index.ts update(): advance the clock, every module in order, then flush the pools.
    env.advance(step.dt);
    for (const m of modules) m.update(step.dt);
    lit.flush();
    glow.flush();
    rings.flush();
    frames.push(diff(snapshot() as Record<string, unknown>));
  }
  return {
    env: { sunLight: env.sunLight.toArray(), ambientLight: env.ambientLight.toArray(), wind: env.wind.toArray(), sunDirection: env.sunDirection.toArray() },
    frames,
  };
}
