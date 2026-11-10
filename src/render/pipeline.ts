import * as THREE from 'three/webgpu';
import {
  convertToTexture,
  float,
  length,
  metalness,
  mix,
  mrt,
  normalView,
  output,
  packNormalToRGB,
  pass,
  renderOutput,
  roughness,
  sample,
  screenUV,
  smoothstep,
  unpackRGBToNormal,
  vec2,
  vec3,
  vec4,
  velocity,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { bilateralBlur } from 'three/addons/tsl/display/BilateralBlurNode.js';
import { film } from 'three/addons/tsl/display/FilmNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { godrays } from 'three/addons/tsl/display/GodraysNode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import type { GraphicsSettings } from '../core/settings';
import type { LightingSetup } from '../world/types';

/**
 * TSL node graphs are typed loosely upstream; the pipeline treats them as opaque
 * values and keeps that looseness inside this file.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;

export interface PipelineInput {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly graphics: GraphicsSettings;
  readonly lighting: LightingSetup | null;
}

export interface PipelineHandles {
  render(): void;
  dispose(): void;
}

/**
 * Builds the frame graph for the current quality settings:
 * scene (MRT) -> ambient occlusion -> reflections -> light shafts -> TRAA ->
 * bloom -> tone map -> FXAA -> vignette and grain.
 */
export function buildPipeline(input: PipelineInput): PipelineHandles {
  const { renderer, scene, camera, sun, graphics, lighting } = input;
  const pipeline = new THREE.RenderPipeline(renderer);
  const disposables: { dispose(): void }[] = [];

  const useTraa = graphics.antiAliasing === 'traa';
  const useAo = graphics.ambientOcclusion;
  const useSsr = graphics.reflections;
  // GodraysNode reads sun.shadow.map when it is built and throws if there is none yet (before
  // the first shadow pass). The engine rebuilds the pipeline once the map exists.
  const useGodrays =
    graphics.volumetricLight && graphics.shadowMapSize > 0 && (lighting?.volumetric ?? 0) > 0 && sun.shadow.map !== null;

  const scenePass = pass(scene, camera);
  disposables.push(scenePass);
  const targets: Record<string, TslNode> = { output };
  if (useAo || useSsr) targets.normal = packNormalToRGB(normalView);
  if (useSsr) targets.metalrough = vec2(metalness, roughness);
  if (useTraa) targets.velocity = velocity;
  const sceneTargets = mrt(targets);
  // See-through materials (particles, decals, glass) write alpha 0 to the surface
  // data targets; this blend mode makes that leave what is behind them untouched.
  const keepBehind = new THREE.BlendMode(THREE.NormalBlending);
  for (const name of ['normal', 'metalrough', 'velocity']) {
    if (name in targets) sceneTargets.setBlendMode(name, keepBehind);
  }
  scenePass.setMRT(sceneTargets);

  // traa() and fxaa() would wrap a composed input in a hidden render-to-texture node that
  // nothing disposes; make that node here so its render target is freed with the pipeline.
  const ownedTexture = (node: TslNode): TslNode => {
    const texture: TslNode = convertToTexture(node);
    if (texture !== node && typeof texture.dispose === 'function') disposables.push(texture);
    return texture;
  };

  const sceneColor: TslNode = scenePass.getTextureNode('output');
  const sceneDepth: TslNode = scenePass.getTextureNode('depth');
  let color: TslNode = sceneColor;

  if (useAo || useSsr) {
    const normalTexture = scenePass.getTexture('normal');
    normalTexture.type = THREE.UnsignedByteType;
  }
  const sceneNormal: TslNode =
    useAo || useSsr
      ? sample((uv: TslNode) => unpackRGBToNormal(scenePass.getTextureNode('normal').sample(uv)))
      : null;

  if (useAo) {
    const aoPass = ao(sceneDepth, sceneNormal, camera);
    aoPass.resolutionScale = graphics.tier === 'ultra' ? 1 : 0.5;
    aoPass.radius.value = 0.6;
    aoPass.thickness.value = 1.2;
    aoPass.samples.value = graphics.tier === 'medium' ? 8 : 12;
    aoPass.useTemporalFiltering = useTraa;
    disposables.push(aoPass);
    color = vec4(color.rgb.mul(aoPass.getTextureNode().r), color.a);
  }

  if (useSsr) {
    const metalRough: TslNode = scenePass.getTextureNode('metalrough');
    const ssrPass = ssr(sceneColor, sceneDepth, sceneNormal, {
      metalnessNode: metalRough.r,
      roughnessNode: metalRough.g,
      reflectNonMetals: true,
      camera,
    });
    // Half resolution on every tier: at full resolution this one pass cost more than the rest
    // of the ultra frame together, and rough wet ground blurs the difference away.
    ssrPass.resolutionScale = 0.5;
    ssrPass.maxDistance.value = 14;
    ssrPass.thickness.value = 0.35;
    ssrPass.intensity.value = 0.8;
    disposables.push(ssrPass);
    const reflection: TslNode = ssrPass.getTextureNode();
    color = vec4(color.rgb.add(reflection.rgb.mul(reflection.a)), color.a);
  }

  if (useGodrays && lighting) {
    const rays = godrays(sceneDepth, camera, sun);
    rays.raymarchSteps.value = graphics.tier === 'medium' ? 32 : 48;
    // GodraysNode divides density by 100 internally; these values give a few
    // percent of in-scatter per 10 m in clear air and much more in mist.
    rays.density.value = (0.012 + lighting.fog.density * 1.6) * shaftBoost(lighting);
    rays.maxDensity.value = 0.25 + 0.5 * lighting.volumetric;
    rays.distanceAttenuation.value = 1.5;
    disposables.push(rays);
    const blurred: TslNode = bilateralBlur(rays.getTextureNode(), undefined, 3, 0.1);
    // The shafts are marched at half resolution; blurring them at full resolution only costs time.
    blurred.resolutionScale = rays.resolutionScale;
    disposables.push(blurred);
    // In-scattered sunlight: fade the scene toward the sun colour where shafts are dense.
    const shaftColor = new THREE.Color(lighting.sunColor).multiplyScalar(lighting.sunIntensity * 0.22);
    const amount: TslNode = blurred.getTextureNode().r.mul(lighting.volumetric);
    color = vec4(mix(color.rgb, vec3(shaftColor.r, shaftColor.g, shaftColor.b), amount), color.a);
  }

  if (useTraa) {
    const taa = traa(ownedTexture(color), sceneDepth, scenePass.getTextureNode('velocity'), camera);
    disposables.push(taa);
    color = taa;
  }

  if (graphics.bloom) {
    const strength = 0.22 * (lighting?.bloom ?? 1);
    const bloomPass = bloom(color, strength, 0.6, 1.0);
    disposables.push(bloomPass);
    color = color.add(bloomPass);
  }

  // Everything below works on display-referred colour.
  let display: TslNode = renderOutput(color);
  if (graphics.antiAliasing === 'fxaa') {
    const aa = fxaa(ownedTexture(display));
    disposables.push(aa);
    display = aa;
  }

  const fromCentre = length(screenUV.sub(0.5));
  const vignette = mix(float(1), float(0.78), smoothstep(0.35, 0.85, fromCentre));
  display = vec4(vec3(display.rgb).mul(vignette), 1);
  if (graphics.filmGrain) display = film(display, float(0.055));

  pipeline.outputColorTransform = false;
  pipeline.outputNode = display;

  return {
    render: () => pipeline.render(),
    dispose: () => {
      for (const item of disposables) item.dispose();
      pipeline.dispose();
    },
  };
}

/** Per-map shaft density multiplier; `?shafts=<n>` overrides it for tuning. */
function shaftBoost(lighting: LightingSetup): number {
  const override = Number(new URLSearchParams(globalThis.location?.search ?? '').get('shafts'));
  return Number.isFinite(override) && override > 0 ? override : (lighting.shaftDensity ?? 1);
}
