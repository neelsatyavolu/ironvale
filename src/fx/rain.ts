import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  cross,
  dot,
  fract,
  instancedBufferAttribute,
  length,
  max,
  mix,
  normalize,
  pow,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { seededRandom } from '../core/random';
import { RENDER_ORDER, leaveSurfaceDataAlone, type FxEnv, type TslNode } from './shared';

/** Streaks at full detail density. */
const MAX_STREAKS = 7000;
/** Volume of rain that follows the camera, in metres. */
const BOX = new THREE.Vector3(26, 16, 26);
/** The volume is pushed this far ahead of the camera, where it is seen. */
const LEAD = 6;
const FALL_SPEED = 9.5;
const OPACITY = 0.3;
const MIN_WIDTH = 0.0032;
const MIN_WIDTH_PER_METRE = 0.0021;
/** Under a roof, streaks this close to the eye are dropped in case the mask is a cell out at a wall. */
const INDOOR_CLEAR_RADIUS = 1.4;

export interface RoofMaskTexture {
  readonly texture: THREE.Texture;
  /** World metres covered by the whole texture before it repeats. */
  readonly span: number;
}

/**
 * Falling rain: streaks that live in a box around the camera and wrap from one
 * side to the other. Positions come from the effect clock in the vertex shader,
 * and each streak is hidden where the roof mask says there is cover above it.
 */
export class Rain {
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly seeds: THREE.InstancedBufferAttribute;
  private readonly centre: TslNode = uniform(new THREE.Vector3());
  private readonly fall: TslNode = uniform(new THREE.Vector3(0, -FALL_SPEED, 0));
  private readonly indoors: TslNode = uniform(0);
  private readonly forward = new THREE.Vector3();

  constructor(
    private readonly env: FxEnv,
    mask: RoofMaskTexture,
  ) {
    const random = seededRandom(0x7a1);
    const seeds = new Float32Array(MAX_STREAKS * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = random();
    this.seeds = new THREE.InstancedBufferAttribute(seeds, 4);
    this.material = this.buildMaterial(mask);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    leaveSurfaceDataAlone(this.mesh, this.material);
    this.mesh.count = MAX_STREAKS;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = RENDER_ORDER.rain;
    this.mesh.visible = false;
    env.root.add(this.mesh);
  }

  setActive(active: boolean): void {
    this.mesh.visible = active;
  }

  update(dt: number): void {
    if (!this.mesh.visible) return;
    const camera = this.env.camera;
    this.mesh.count = Math.max(1, Math.round(MAX_STREAKS * this.env.detailDensity));
    camera.getWorldDirection(this.forward);
    this.forward.y = 0;
    this.centre.value.copy(camera.position).addScaledVector(this.forward, LEAD);
    this.fall.value.set(this.env.wind.x, -FALL_SPEED, this.env.wind.z);
    const target = this.env.ctx.player.indoors ? 1 : 0;
    this.indoors.value += (target - this.indoors.value) * Math.min(1, dt * 8);
  }

  dispose(): void {
    this.env.root.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }

  private buildMaterial(mask: RoofMaskTexture): THREE.MeshBasicNodeMaterial {
    const env = this.env;
    const seed: TslNode = instancedBufferAttribute(this.seeds, 'vec4');
    const box: TslNode = vec3(BOX.x, BOX.y, BOX.z);
    const velocity: TslNode = this.fall.mul(seed.w.mul(0.4).add(0.8));
    // Each drop moves through the world in a straight line; wrapping keeps it inside the box around the camera.
    const travelled: TslNode = seed.xyz.mul(box).add(velocity.mul(env.time));
    const centre: TslNode = this.centre;
    const drop: TslNode = centre.add(fract(travelled.sub(centre).div(box).add(0.5)).sub(0.5).mul(box));

    const heading: TslNode = normalize(this.fall);
    const toEye: TslNode = cameraPosition.sub(drop);
    const distance: TslNode = length(toEye);
    const side: TslNode = normalize(cross(heading, toEye).add(vec3(1e-5, 0, 0)));

    const roof: TslNode = texture(mask.texture, drop.xz.div(mask.span)).r;
    const open: TslNode = step(roof, drop.y);
    const flat: TslNode = length(vec2(toEye.x, toEye.z));
    const nearFade: TslNode = smoothstep(0.5, 1.8, distance);
    const indoorFade: TslNode = mix(1, smoothstep(INDOOR_CLEAR_RADIUS, INDOOR_CLEAR_RADIUS * 2, flat), this.indoors);
    const fromCentre: TslNode = length(drop.xz.sub(centre.xz)).div(BOX.x);
    const edgeFade: TslNode = smoothstep(0.36, 0.5, fromCentre).oneMinus();
    const visible: TslNode = open.mul(nearFade).mul(indoorFade).mul(edgeFade);

    const streak: TslNode = seed.w.mul(0.35).add(0.38);
    const width: TslNode = max(MIN_WIDTH, distance.mul(MIN_WIDTH_PER_METRE)).mul(step(0.001, visible));
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    material.positionNode = drop
      .add(heading.mul(uv().y.sub(0.5).mul(streak)))
      .add(side.mul(uv().x.sub(0.5).mul(width)));

    // Drops scatter sunlight forward, so rain is brightest looking toward the sun.
    const towardSun: TslNode = max(dot(normalize(toEye).negate(), env.sunDirectionNode), 0);
    const light: TslNode = varying(env.ambientLightNode.mul(1.25).add(env.sunLightNode.mul(pow(towardSun, 6).mul(3).add(0.35))));
    const strength: TslNode = varying(visible.mul(OPACITY).mul(seed.x.mul(0.5).add(0.6)));
    const across: TslNode = uv().x.sub(0.5).mul(2).abs();
    const profile: TslNode = across.mul(across).oneMinus().mul(sin(uv().y.mul(Math.PI)));
    material.colorNode = vec4(light, strength.mul(profile));
    material.alphaTest = 0.01;
    return material;
  }
}
