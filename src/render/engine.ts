import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  color as colorNode,
  densityFogFactor,
  dot,
  exp,
  float,
  fog,
  max,
  mix,
  positionWorld,
  uniform,
} from 'three/tsl';
import type { GraphicsSettings } from '../core/settings';
import type { LightingSetup } from '../world/types';
import { DynamicResolution } from './dynamic-resolution';
import { buildPipeline, type PipelineHandles } from './pipeline';

/** Half-width in metres of the square the sun shadow map covers around the player. */
const SHADOW_RADIUS = 55;
const SHADOW_DISTANCE = 160;
const MAX_FRAME_DT = 0.05;
const BACKDROP_GAIN = 1.5;
const MIN_RENDER_SCALE = 0.5;
/** On the low tier the sun shadow map is redrawn every this many frames; the pass is about half the triangles drawn. */
const LOW_TIER_SHADOW_INTERVAL = 2;

// TSL node types are loose upstream; fog composition treats them as opaque.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FogNode = any;

export type FrameCallback = (dt: number, elapsed: number) => void;

/**
 * Owns the renderer, the scene graph root, the camera, the sun and the
 * post-processing pipeline. Gameplay systems register frame callbacks; the
 * engine calls them in registration order and then draws.
 */
export class Engine {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(75, 1, 0.04, 900);
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  /** true when running on WebGPU, false on the WebGL2 fallback. */
  readonly isWebGPU: boolean;

  private pipeline: PipelineHandles | null = null;
  private lighting: LightingSetup | null = null;
  /** Replaced, never mutated, so the frame loop can iterate it without copying. */
  private callbacks: readonly FrameCallback[] = [];
  /** The sun shadow map the current pipeline's light shafts were built against. */
  private pipelineShadowMap: THREE.RenderTarget | null = null;
  private readonly timer = new THREE.Timer();
  private readonly dynamicResolution = new DynamicResolution();
  private frameMs = 16.7;
  private skyLight = 1;
  private running = false;
  private shadowInterval = 1;
  private shadowCountdown = 0;

  private readonly sunRight = new THREE.Vector3();
  private readonly sunUp = new THREE.Vector3();
  private readonly sunDir = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
  private readonly scratch = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();

  private constructor(
    readonly renderer: THREE.WebGPURenderer,
    readonly canvas: HTMLCanvasElement,
    private graphics: GraphicsSettings,
  ) {
    this.isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
    this.scene.add(this.camera);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.04;
    const cam = this.sun.shadow.camera;
    cam.left = -SHADOW_RADIUS;
    cam.right = SHADOW_RADIUS;
    cam.top = SHADOW_RADIUS;
    cam.bottom = -SHADOW_RADIUS;
    cam.near = 1;
    cam.far = SHADOW_DISTANCE * 2;
    this.scene.add(this.sun, this.sun.target);
    window.addEventListener('resize', this.resize);
  }

  static async create(canvas: HTMLCanvasElement, graphics: GraphicsSettings): Promise<Engine> {
    const params = new URLSearchParams(location.search);
    const forceWebGL = params.has('webgl');
    const renderer = new THREE.WebGPURenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      forceWebGL,
      // ?gputime turns on GPU timestamp queries for scripts/dev/review-perf-bench.mjs.
      trackTimestamp: params.has('gputime'),
    });
    await renderer.init();
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const engine = new Engine(renderer, canvas, graphics);
    engine.applyGraphics(graphics);
    return engine;
  }

  get frameTimeMs(): number {
    return this.frameMs;
  }

  /** Effective fraction of device pixels being rendered right now. */
  get renderScale(): number {
    return this.graphics.renderScale * this.dynamicResolution.scale;
  }

  get graphicsSettings(): GraphicsSettings {
    return this.graphics;
  }

  onFrame(callback: FrameCallback): () => void {
    this.callbacks = [...this.callbacks, callback];
    return () => {
      this.callbacks = this.callbacks.filter((entry) => entry !== callback);
    };
  }

  setFov(fov: number): void {
    if (Math.abs(this.camera.fov - fov) < 1e-3) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Apply sky, sun, fog and exposure for a map. `environment` is the equirect
   * HDR that lights the scene; `backdrop` is an optional sharper panorama shown
   * behind the level.
   */
  setLighting(lighting: LightingSetup, environment: THREE.Texture, backdrop: THREE.Texture | null = null): void {
    this.lighting = lighting;
    environment.mapping = THREE.EquirectangularReflectionMapping;
    this.scene.background = backdrop ?? environment;
    this.scene.environment = environment;
    this.scene.backgroundRotation.set(0, lighting.hdriRotation, 0);
    this.scene.environmentRotation.set(0, lighting.hdriRotation, 0);
    // A tone-mapped backdrop is already display-referred; lift it so it survives the second tone map.
    this.scene.backgroundIntensity = lighting.skyIntensity * (backdrop ? BACKDROP_GAIN : 1);
    this.scene.environmentIntensity = lighting.skyIntensity;
    this.sunDir.copy(lighting.sunDirection).normalize();
    this.applyFog(lighting);
    this.skyLight = 1;
    this.sun.color.setHex(lighting.sunColor);
    this.sun.intensity = lighting.sunIntensity;
    this.renderer.toneMappingExposure = lighting.exposure;
    // Basis for snapping the shadow frustum to whole texels (stops shadow shimmer).
    this.sunRight.crossVectors(new THREE.Vector3(0, 1, 0), this.sunDir).normalize();
    this.sunUp.crossVectors(this.sunDir, this.sunRight).normalize();
    this.rebuildPipeline();
  }

  /**
   * Scale image-based lighting, eased over a fraction of a second. The game
   * lowers it while the player is inside an interior zone.
   */
  setSkyLight(target: number, dt: number): void {
    if (!this.lighting) return;
    const next = THREE.MathUtils.damp(this.skyLight, target, 5, dt);
    if (Math.abs(next - this.skyLight) < 1e-4) return;
    this.skyLight = next;
    this.scene.environmentIntensity = this.lighting.skyIntensity * next;
  }

  /**
   * Exponential distance fog with two optional refinements from the map: a
   * warmer colour when looking toward the sun, and thinning with height.
   */
  private applyFog(lighting: LightingSetup): void {
    const setup = lighting.fog;
    this.scene.fog = null;
    if (setup.density <= 0) {
      this.scene.fogNode = null;
      return;
    }
    const base = colorNode(setup.color);
    const tintStrength = setup.sunTintStrength ?? 0;
    let fogColor: FogNode = base;
    if (setup.sunTint !== undefined && tintStrength > 0) {
      const view = positionWorld.sub(cameraPosition).normalize();
      const towardSun = max(dot(view, uniform(this.sunDir.clone())), 0).pow(5);
      fogColor = mix(base, colorNode(setup.sunTint), towardSun.mul(tintStrength));
    }
    let factor: FogNode = densityFogFactor(float(setup.density));
    const falloff = setup.heightFalloff ?? 0;
    if (falloff > 0) {
      const above = max(positionWorld.y.sub(setup.baseHeight ?? 0), 0);
      // Never drop below a quarter of the base fog, so distant high objects still fade.
      factor = factor.mul(max(exp(above.mul(-falloff)), 0.25));
    }
    this.scene.fogNode = fog(fogColor, factor);
  }

  applyGraphics(graphics: GraphicsSettings): void {
    const previous = this.graphics;
    this.graphics = graphics;
    this.dynamicResolution.reset();
    this.sun.castShadow = graphics.shadowMapSize > 0;
    // The renderer resizes the shadow map to mapSize itself on the next shadow pass. Do not
    // dispose or null `shadow.map` here: light shafts read it when the pipeline is built.
    if (graphics.shadowMapSize > 0) this.sun.shadow.mapSize.set(graphics.shadowMapSize, graphics.shadowMapSize);
    this.shadowInterval = graphics.tier === 'low' ? LOW_TIER_SHADOW_INTERVAL : 1;
    this.shadowCountdown = 0;
    this.sun.shadow.autoUpdate = this.shadowInterval === 1;
    this.resize();
    const structural =
      !this.pipeline ||
      // The tier sets sample counts and pass resolutions inside the pipeline.
      previous.tier !== graphics.tier ||
      previous.ambientOcclusion !== graphics.ambientOcclusion ||
      previous.reflections !== graphics.reflections ||
      previous.volumetricLight !== graphics.volumetricLight ||
      previous.bloom !== graphics.bloom ||
      previous.antiAliasing !== graphics.antiAliasing ||
      previous.filmGrain !== graphics.filmGrain ||
      previous.shadowMapSize !== graphics.shadowMapSize;
    if (structural) this.rebuildPipeline();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer.reset();
    void this.renderer.setAnimationLoop(this.frame);
  }

  stop(): void {
    this.running = false;
    void this.renderer.setAnimationLoop(null);
  }

  /**
   * Draw a few frames ahead of play so every material and pass has its GPU
   * pipeline before the match starts. (renderer.compileAsync is not used: it
   * compiles outside the scene pass's render-target layout, which is invalid
   * for materials that write to the extra targets.)
   */
  async warmUp(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      this.renderOnce();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }

  /** Draw one frame without advancing game time. Used for screenshots and paused menus. */
  renderOnce(): void {
    this.updateSun();
    this.pipeline?.render();
    this.followShadowMap();
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.resize);
    this.pipeline?.dispose();
    this.renderer.dispose();
  }

  private rebuildPipeline(): void {
    this.pipeline?.dispose();
    this.pipeline = buildPipeline({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      sun: this.sun,
      graphics: this.graphics,
      lighting: this.lighting,
    });
    this.pipelineShadowMap = this.sun.shadow.map;
  }

  /**
   * Light shafts sample the sun's shadow map, which the renderer creates on the
   * first shadow pass and replaces when shadows are switched off and on. Rebuild
   * once the map exists or changes so the shafts never read a missing or stale one.
   */
  private followShadowMap(): void {
    if (this.sun.shadow.map === this.pipelineShadowMap) return;
    const shafts =
      this.graphics.volumetricLight && this.graphics.shadowMapSize > 0 && (this.lighting?.volumetric ?? 0) > 0;
    if (shafts) this.rebuildPipeline();
    else this.pipelineShadowMap = this.sun.shadow.map;
  }

  private readonly frame = (): void => {
    this.timer.update();
    const rawDt = this.timer.getDelta();
    const dt = Math.min(rawDt, MAX_FRAME_DT);
    const elapsed = this.timer.getElapsed();
    this.frameMs += (rawDt * 1000 - this.frameMs) * 0.05;
    const callbacks = this.callbacks;
    for (let i = 0; i < callbacks.length; i++) callbacks[i]!(dt, elapsed);
    this.updateSun();
    this.adaptResolution(rawDt);
    this.pipeline?.render();
    this.followShadowMap();
  };

  private readonly resize = (): void => {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(window.devicePixelRatio * this.renderScale);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  };

  /** Keep the shadow frustum centred slightly ahead of the camera, snapped to texels. */
  private updateSun(): void {
    if (!this.sun.castShadow) return;
    if (this.shadowInterval > 1) {
      // Move the frustum only on the frames the map is redrawn, so the two never disagree.
      if (this.shadowCountdown-- > 0) return;
      this.shadowCountdown = this.shadowInterval - 1;
      this.sun.shadow.needsUpdate = true;
    }
    this.camera.getWorldDirection(this.forward);
    this.forward.y = 0;
    if (this.forward.lengthSq() > 1e-6) this.forward.normalize();
    const center = this.scratch.copy(this.camera.position).addScaledVector(this.forward, SHADOW_RADIUS * 0.55);
    const texel = (SHADOW_RADIUS * 2) / Math.max(1, this.sun.shadow.mapSize.x);
    const r = Math.round(center.dot(this.sunRight) / texel) * texel;
    const u = Math.round(center.dot(this.sunUp) / texel) * texel;
    const d = center.dot(this.sunDir);
    center
      .set(0, 0, 0)
      .addScaledVector(this.sunRight, r)
      .addScaledVector(this.sunUp, u)
      .addScaledVector(this.sunDir, d);
    this.sun.target.position.copy(center);
    this.sun.position.copy(center).addScaledVector(this.sunDir, SHADOW_DISTANCE);
    this.sun.target.updateMatrixWorld();
  }

  /** Step the render scale down when frames run long and back up when there is headroom. */
  private adaptResolution(rawDt: number): void {
    if (!this.graphics.dynamicResolution) return;
    const floor = Math.min(1, MIN_RENDER_SCALE / this.graphics.renderScale);
    if (this.dynamicResolution.update(rawDt, 1 / this.graphics.targetFps, floor)) this.resize();
  }
}
