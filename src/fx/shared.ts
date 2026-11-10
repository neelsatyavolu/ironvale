import * as THREE from 'three/webgpu';
import { cameraViewMatrix, mrt, packNormalToRGB, uniform, vec3, vec4 } from 'three/tsl';
import type { GameContext } from '../game/contracts';
import type { LightingSetup, MapInstance, Weather } from '../world/types';

/**
 * TSL node graphs are typed loosely upstream. Effects treat them as opaque
 * values, the same way the render pipeline does.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TslNode = any;

/** One effect family. `index.ts` drives every module the same way. */
export interface FxModule {
  enterMap?(map: MapInstance): void;
  update(dt: number): void;
  /** Drop everything live (map unload). */
  clear(): void;
  dispose(): void;
}

/** Draw order among the transparent effects; nothing here writes depth. */
export const RENDER_ORDER = {
  decals: 1,
  rings: 2,
  mist: 3,
  particles: 4,
  rain: 5,
  glow: 6,
  tracers: 7,
  flash: 8,
} as const;

/** Share of direct sunlight a cloud of dust or spray scatters toward the eye. */
const SUN_SCATTER = 0.2;
/** The fog colour stands in for sky light on particles. */
const AMBIENT_FROM_FOG = 0.85;
const SUN_PROBE_DISTANCE = 60;
const SUN_PROBE_LIFT = 0.06;
const WIND: Readonly<Record<Weather, readonly [number, number, number]>> = {
  clear: [0.45, 0, 0.25],
  mist: [0.3, 0, 0.18],
  rain: [2.4, 0, 1.2],
};

/** State every effect shares: the effect clock, the map's light and wind, and the quality settings. */
export class FxEnv {
  /** Parent of every effect object. */
  readonly root = new THREE.Group();
  /** Effect clock in seconds, for shaders. Stops while the game is paused. */
  readonly time: TslNode = uniform(0);
  readonly windNode: TslNode = uniform(new THREE.Vector3());
  readonly sunDirectionNode: TslNode = uniform(new THREE.Vector3(0, 1, 0));
  readonly sunLightNode: TslNode = uniform(new THREE.Color(1, 1, 1));
  readonly ambientLightNode: TslNode = uniform(new THREE.Color(0.4, 0.4, 0.4));
  /** CPU copy of the effect clock. */
  now = 0;
  /** true while a map is loaded. Events that arrive outside a match are ignored. */
  live = false;
  weather: Weather = 'clear';
  readonly wind = new THREE.Vector3();
  readonly sunDirection = new THREE.Vector3(0, 1, 0);
  /** Sunlight a particle scatters, linear RGB. */
  readonly sunLight = new THREE.Color(1, 1, 1);
  /** Sky light a particle scatters, linear RGB. */
  readonly ambientLight = new THREE.Color(0.4, 0.4, 0.4);

  private readonly probeFrom = new THREE.Vector3();
  private readonly probeTo = new THREE.Vector3();

  constructor(readonly ctx: GameContext) {
    this.root.name = 'fx';
    ctx.engine.scene.add(this.root);
  }

  /** 0 - 1, read live so a settings change applies at once. */
  get particleDensity(): number {
    return this.ctx.settings.value.graphics.particleDensity;
  }

  get detailDensity(): number {
    return this.ctx.settings.value.graphics.detailDensity;
  }

  get camera(): THREE.PerspectiveCamera {
    return this.ctx.engine.camera;
  }

  advance(dt: number): void {
    this.now += dt;
    this.time.value = this.now;
  }

  setMap(lighting: LightingSetup, weather: Weather): void {
    this.live = true;
    this.weather = weather;
    this.sunDirection.copy(lighting.sunDirection).normalize();
    this.sunLight.setHex(lighting.sunColor).multiplyScalar(lighting.sunIntensity * SUN_SCATTER);
    this.ambientLight.setHex(lighting.fog.color).multiplyScalar(lighting.skyIntensity * AMBIENT_FROM_FOG);
    const [wx, wy, wz] = WIND[weather];
    this.wind.set(wx, wy, wz);
    this.windNode.value.copy(this.wind);
    this.sunDirectionNode.value.copy(this.sunDirection);
    this.sunLightNode.value.copy(this.sunLight);
    this.ambientLightNode.value.copy(this.ambientLight);
  }

  /** 1 when the sun reaches a point just off a surface, 0 when the level shadows it. */
  sunAt(point: THREE.Vector3, normal: THREE.Vector3 | null): number {
    this.probeFrom.copy(point);
    if (normal) this.probeFrom.addScaledVector(normal, SUN_PROBE_LIFT);
    this.probeTo.copy(this.probeFrom).addScaledVector(this.sunDirection, SUN_PROBE_DISTANCE);
    return this.ctx.world.lineOfSight(this.probeFrom, this.probeTo) ? 1 : 0;
  }

  /** Light a particle of the given albedo: sky light plus sunlight where `sun` (0 - 1) reaches. */
  shade(albedoR: number, albedoG: number, albedoB: number, sun: number, out: THREE.Color): THREE.Color {
    return out.setRGB(
      albedoR * (this.ambientLight.r + this.sunLight.r * sun),
      albedoG * (this.ambientLight.g + this.sunLight.g * sun),
      albedoB * (this.ambientLight.b + this.sunLight.b * sun),
    );
  }

  dispose(): void {
    this.ctx.engine.scene.remove(this.root);
  }
}

/** Extra scene-pass targets (besides colour) that see-through effects must leave alone. */
const SURFACE_TARGETS = ['normal', 'metalrough', 'velocity'] as const;
const KEEP_BEHIND = new THREE.BlendMode(THREE.NormalBlending);

interface ScenePassTargets {
  readonly blendModes: Record<string, THREE.BlendMode | undefined>;
  setBlendMode(name: string, mode: THREE.BlendMode): unknown;
}

/**
 * Set up a see-through effect so it does not disturb ambient occlusion,
 * reflections or temporal anti-aliasing.
 *
 * The scene pass writes normals, metal/roughness and velocity next to colour,
 * and by default those extra targets do not blend: any fragment an effect draws
 * replaces the surface data of whatever is behind it, which shows up as dark
 * occlusion blotches and missing reflections in the shape of every sprite.
 *
 * Two parts fix that. The material writes those targets with zero alpha, and
 * the mesh, just before it draws, makes sure the pass blends them by alpha, so
 * the zero-alpha write leaves the surface data untouched. Opaque materials
 * write alpha 1 there and are unaffected. A target the pipeline has already
 * given a blend mode is left as configured.
 *
 * Without per-target blending (WebGL2 fallback) the colour part is still
 * written, so it holds the values of a rough, up-facing floor: the most likely
 * thing behind a puff of dust.
 */
export function leaveSurfaceDataAlone(mesh: THREE.Object3D, material: THREE.NodeMaterial): void {
  const viewUp = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz;
  material.mrtNode = mrt({
    normal: vec4(packNormalToRGB(vec3(viewUp)), 0),
    metalrough: vec4(0, 1, 0, 0),
    velocity: vec4(0, 0, 0, 0),
  });
  mesh.onBeforeRender = (renderer) => {
    const targets = (renderer as unknown as { getMRT(): ScenePassTargets | null }).getMRT();
    if (!targets) return;
    for (const name of SURFACE_TARGETS) {
      if (targets.blendModes[name] === undefined) targets.setBlendMode(name, KEEP_BEHIND);
    }
  };
}

/** Uniform random number in [min, max). */
export function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Random unit vector within `spread` (0 = along the axis, 1 = a full hemisphere) of `axis`, written to `out`. */
export function randomInCone(axis: THREE.Vector3, spread: number, out: THREE.Vector3): THREE.Vector3 {
  // Pick a random direction, keep the half facing the axis, then blend toward the axis.
  let x = 0;
  let y = 0;
  let z = 0;
  let lengthSq = 0;
  do {
    x = Math.random() * 2 - 1;
    y = Math.random() * 2 - 1;
    z = Math.random() * 2 - 1;
    lengthSq = x * x + y * y + z * z;
  } while (lengthSq > 1 || lengthSq < 1e-4);
  out.set(x, y, z).divideScalar(Math.sqrt(lengthSq));
  if (out.dot(axis) < 0) out.negate();
  return out.multiplyScalar(spread).addScaledVector(axis, 1 - spread * 0.5).normalize();
}
