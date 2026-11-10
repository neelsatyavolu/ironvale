import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  cameraWorldMatrix,
  dot,
  float,
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
import type { RoofMaskTexture } from './rain';
import { RENDER_ORDER, leaveSurfaceDataAlone, type FxEnv, type TslNode } from './shared';
import { SPRITE, SPRITE_GRID } from './textures';

/** Fog banks at full detail density, and the square they wrap inside. */
const MAX_BANKS = 56;
const BANK_AREA = 76;
const BANK_OPACITY = 0.2;
/** Banks fade out this close to the eye so walking through one never shows its edge. */
const BANK_NEAR_START = 3.5;
const BANK_NEAR_END = 10;

/** Dust motes at full detail density, and the box around the camera they drift in. */
const MAX_MOTES = 520;
const MOTE_BOX = new THREE.Vector3(15, 7, 15);
const MOTE_LEAD = 4;
const MOTE_MIN_WIDTH_PER_METRE = 0.0017;

function seedAttribute(count: number, seed: number): THREE.InstancedBufferAttribute {
  const random = seededRandom(seed);
  const data = new Float32Array(count * 4);
  for (let i = 0; i < data.length; i++) data[i] = random();
  return new THREE.InstancedBufferAttribute(data, 4);
}

/** UV of one cell of the particle sprite sheet. */
function spriteUv(cell: number): TslNode {
  const column = cell % SPRITE_GRID;
  const row = Math.floor(cell / SPRITE_GRID);
  return vec2(uv().x.add(column).div(SPRITE_GRID), float(1).sub(float(row + 1).sub(uv().y).div(SPRITE_GRID)));
}

/**
 * Ground mist: large, very soft sprites that drift with the wind and wrap
 * around the player, lit by the sky and glowing toward the sun.
 */
export class FogBanks {
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly seeds = seedAttribute(MAX_BANKS, 0xf06);
  private readonly centre: TslNode = uniform(new THREE.Vector3());
  private readonly indoors: TslNode = uniform(0);
  private groundY = 0;
  private placed = false;

  constructor(
    private readonly env: FxEnv,
    atlas: THREE.Texture,
  ) {
    this.material = this.buildMaterial(atlas);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    leaveSurfaceDataAlone(this.mesh, this.material);
    this.mesh.count = MAX_BANKS;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = RENDER_ORDER.mist;
    this.mesh.visible = false;
    env.root.add(this.mesh);
  }

  setActive(active: boolean): void {
    this.mesh.visible = active;
    this.placed = false;
  }

  update(dt: number): void {
    if (!this.mesh.visible) return;
    const player = this.env.ctx.player;
    this.mesh.count = Math.max(1, Math.round(MAX_BANKS * this.env.detailDensity));
    // Follow the player's feet slowly so stairs and jumps do not bounce the whole layer.
    const feet = player.position.y;
    this.groundY = this.placed ? this.groundY + (feet - this.groundY) * Math.min(1, dt * 0.6) : feet;
    this.placed = true;
    this.centre.value.set(player.position.x, this.groundY, player.position.z);
    const target = player.indoors ? 1 : 0;
    this.indoors.value += (target - this.indoors.value) * Math.min(1, dt * 2);
  }

  dispose(): void {
    this.env.root.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }

  private buildMaterial(atlas: THREE.Texture): THREE.MeshBasicNodeMaterial {
    const env = this.env;
    const seed: TslNode = instancedBufferAttribute(this.seeds, 'vec4');
    const centre: TslNode = this.centre;
    const drift: TslNode = env.windNode.xz.mul(env.time).mul(seed.w.mul(0.8).add(0.6));
    const raw: TslNode = seed.xz.mul(BANK_AREA).add(drift);
    const flat: TslNode = centre.xz.add(fract(raw.sub(centre.xz).div(BANK_AREA).add(0.5)).sub(0.5).mul(BANK_AREA));
    const width: TslNode = seed.y.mul(7).add(8);
    const height: TslNode = width.mul(0.34);
    // The sprite's soft lower edge sits just under the ground so it never ends on a visible line.
    const base: TslNode = vec3(flat.x, centre.y.add(height.mul(0.42)).add(seed.w.mul(0.7)), flat.y);

    const right: TslNode = cameraWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz;
    const corner: TslNode = uv().sub(0.5);
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    const toEye: TslNode = cameraPosition.sub(base);
    const distance: TslNode = length(toEye);
    const nearFade: TslNode = smoothstep(BANK_NEAR_START, BANK_NEAR_END, distance);
    const fromCentre: TslNode = length(flat.sub(centre.xz)).div(BANK_AREA);
    const edgeFade: TslNode = smoothstep(0.34, 0.49, fromCentre).oneMinus();
    const breathing: TslNode = sin(env.time.mul(0.17).add(seed.x.mul(6.28))).mul(0.25).add(0.75);
    const visible: TslNode = nearFade.mul(edgeFade).mul(breathing).mul(mix(1, 0.35, this.indoors));
    // Banks that are fully faded collapse to a point so they cost no fill.
    const shown: TslNode = step(0.001, visible);
    material.positionNode = base
      .add(right.mul(corner.x.mul(width).mul(shown)))
      .add(vec3(0, 1, 0).mul(corner.y.mul(height).mul(shown)));

    const towardSun: TslNode = max(dot(normalize(toEye).negate(), env.sunDirectionNode), 0);
    const light: TslNode = varying(env.ambientLightNode.mul(1.1).add(env.sunLightNode.mul(pow(towardSun, 4).mul(1.5).add(0.3))));
    const strength: TslNode = varying(visible.mul(BANK_OPACITY).mul(seed.y.mul(0.5).add(0.6)));
    const sample: TslNode = texture(atlas, spriteUv(SPRITE.puffA));
    material.colorNode = vec4(light.mul(sample.rgb), strength.mul(sample.a));
    material.alphaTest = 0.003;
    return material;
  }
}

/** Dust motes hanging in the air near the camera, glinting when they catch the sun. */
export class Motes {
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly seeds = seedAttribute(MAX_MOTES, 0x307e);
  private readonly centre: TslNode = uniform(new THREE.Vector3());
  private readonly forward = new THREE.Vector3();
  /** Share of `MAX_MOTES` to draw before the detail setting is applied. */
  private amount = 0;

  constructor(
    private readonly env: FxEnv,
    atlas: THREE.Texture,
    mask: RoofMaskTexture,
  ) {
    this.material = this.buildMaterial(atlas, mask);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    leaveSurfaceDataAlone(this.mesh, this.material);
    this.mesh.count = MAX_MOTES;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = RENDER_ORDER.glow;
    this.mesh.visible = false;
    env.root.add(this.mesh);
  }

  /** `amount` is 0 - 1: the share of motes this weather shows. */
  setAmount(amount: number): void {
    this.amount = amount;
    this.mesh.visible = amount > 0;
  }

  update(): void {
    if (!this.mesh.visible) return;
    const camera = this.env.camera;
    this.mesh.count = Math.max(1, Math.round(MAX_MOTES * this.amount * this.env.detailDensity));
    camera.getWorldDirection(this.forward);
    this.centre.value.copy(camera.position).addScaledVector(this.forward, MOTE_LEAD);
  }

  dispose(): void {
    this.env.root.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }

  private buildMaterial(atlas: THREE.Texture, mask: RoofMaskTexture): THREE.MeshBasicNodeMaterial {
    const env = this.env;
    const seed: TslNode = instancedBufferAttribute(this.seeds, 'vec4');
    const box: TslNode = vec3(MOTE_BOX.x, MOTE_BOX.y, MOTE_BOX.z);
    const phase: TslNode = seed.w.mul(6.28);
    const wander: TslNode = vec3(
      sin(env.time.mul(0.31).add(phase)),
      sin(env.time.mul(0.23).add(phase.mul(1.7))).mul(0.6),
      sin(env.time.mul(0.27).add(phase.mul(2.3))),
    ).mul(0.3);
    const raw: TslNode = seed.xyz.mul(box).add(env.windNode.mul(env.time).mul(0.3)).add(wander);
    const centre: TslNode = this.centre;
    const mote: TslNode = centre.add(fract(raw.sub(centre).div(box).add(0.5)).sub(0.5).mul(box));

    const toEye: TslNode = cameraPosition.sub(mote);
    const distance: TslNode = length(toEye);
    const size: TslNode = max(seed.x.mul(0.007).add(0.006), distance.mul(MOTE_MIN_WIDTH_PER_METRE));
    const right: TslNode = cameraWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz;
    const up: TslNode = cameraWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz;
    const corner: TslNode = uv().sub(0.5);
    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    material.positionNode = mote.add(right.mul(corner.x).add(up.mul(corner.y)).mul(size));

    const roof: TslNode = texture(mask.texture, mote.xz.div(mask.span)).r;
    const sunlit: TslNode = mix(0.12, 1, step(roof, mote.y));
    const nearFade: TslNode = smoothstep(0.35, 1.1, distance);
    const fromCentre: TslNode = length(mote.sub(centre).div(box));
    const edgeFade: TslNode = smoothstep(0.36, 0.5, fromCentre).oneMinus();
    const twinkle: TslNode = pow(sin(env.time.mul(seed.y.mul(1.6).add(0.7)).add(phase)).mul(0.5).add(0.5), 3)
      .mul(0.75)
      .add(0.25);
    const towardSun: TslNode = max(dot(normalize(toEye).negate(), env.sunDirectionNode), 0);
    const glint: TslNode = env.sunLightNode.mul(pow(towardSun, 5).mul(5).add(0.5)).mul(sunlit).add(env.ambientLightNode.mul(0.2));
    const light: TslNode = varying(glint.mul(twinkle).mul(nearFade).mul(edgeFade));
    const sample: TslNode = texture(atlas, spriteUv(SPRITE.glow));
    material.colorNode = vec4(light, sample.a);
    material.alphaTest = 0.02;
    return material;
  }
}
