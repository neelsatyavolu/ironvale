import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  cameraWorldMatrix,
  cos,
  cross,
  exp,
  float,
  floor,
  instancedBufferAttribute,
  length,
  max,
  mix,
  mod,
  normalize,
  pow,
  select,
  sin,
  smoothstep,
  texture,
  uv,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { DirtyRange, RingPool } from './pool';
import { RENDER_ORDER, leaveSurfaceDataAlone, type FxEnv, type TslNode } from './shared';
import { SPRITE_GRID } from './textures';

/** Floats stored per particle: five vec4s (origin+birth, velocity+life, shape, colour, physics). */
const STRIDE = 20;
const MIN_DRAG = 0.05;
/** Seconds a particle takes to appear, so nothing pops in on a single frame. */
const FADE_IN_SECONDS = 0.035;
/** Particles closer to the eye than this fade out so nothing pops through the near plane. */
const NEAR_FADE_START = 0.12;
const NEAR_FADE_END = 0.5;

/**
 * Everything needed to launch one particle. Emitters fill in the shared
 * instance on the pool (`pool.spawn`) and call `pool.emit()`, so nothing is
 * allocated per particle.
 */
export interface ParticleSpawn {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Seconds. */
  life: number;
  /** Diameter in metres at birth and at death. */
  size: number;
  sizeEnd: number;
  /** Radians and radians per second; ignored by stretched particles. */
  rotation: number;
  spin: number;
  /** Linear colour as it should appear (already lit), and peak opacity. */
  r: number;
  g: number;
  b: number;
  a: number;
  /** Cell of the sprite sheet. */
  sprite: number;
  /** Downward acceleration in m/s^2. Negative values rise (hot smoke). */
  gravity: number;
  /** Air drag per second. High values stop the particle quickly and let the wind carry it. */
  drag: number;
  /**
   * 0 draws a camera-facing sprite. Above 0 the sprite is stretched along its
   * velocity by this many seconds of travel (sparks, falling grit).
   */
  stretch: number;
}

export interface ParticlePoolOptions {
  readonly capacity: number;
  /** Additive particles glow (sparks, flashes); the rest are lit and fogged. */
  readonly additive: boolean;
  /** Shape of the fade-out: 1 is linear, higher holds full strength for longer. */
  readonly fadePower: number;
  readonly atlas: THREE.Texture;
}

/**
 * A pool of sprites simulated entirely in the vertex shader. Each particle is
 * written to the buffer once, at birth; its position at any later time is a
 * closed-form function of age (launch velocity, drag, gravity and wind), so a
 * frame costs nothing on the CPU and only newly born particles are uploaded.
 */
export class ParticlePool {
  /** Scratch spawn description. Fill it in and call `emit()`. */
  readonly spawn: ParticleSpawn = {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    life: 1,
    size: 0.1,
    sizeEnd: 0.1,
    rotation: 0,
    spin: 0,
    r: 1,
    g: 1,
    b: 1,
    a: 1,
    sprite: 0,
    gravity: 0,
    drag: 1,
    stretch: 0,
  };

  private readonly data: Float32Array;
  private readonly buffer: THREE.InstancedInterleavedBuffer;
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly ring: RingPool;
  private readonly dirty = new DirtyRange();

  constructor(
    private readonly env: FxEnv,
    options: ParticlePoolOptions,
  ) {
    this.ring = new RingPool(options.capacity);
    this.data = new Float32Array(options.capacity * STRIDE);
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.material = buildMaterial(env, this.buffer, options);
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    leaveSurfaceDataAlone(this.mesh, this.material);
    this.mesh.count = options.capacity;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = options.additive ? RENDER_ORDER.glow : RENDER_ORDER.particles;
    env.root.add(this.mesh);
  }

  /** Launch the particle described by `spawn`. Recycles the oldest when the pool is full. */
  emit(): void {
    const s = this.spawn;
    const slot = this.ring.next();
    const d = this.data;
    let o = slot * STRIDE;
    d[o++] = s.x;
    d[o++] = s.y;
    d[o++] = s.z;
    d[o++] = this.env.now;
    d[o++] = s.vx;
    d[o++] = s.vy;
    d[o++] = s.vz;
    d[o++] = s.life;
    d[o++] = s.size;
    d[o++] = s.sizeEnd;
    d[o++] = s.rotation;
    d[o++] = s.spin;
    d[o++] = s.r;
    d[o++] = s.g;
    d[o++] = s.b;
    d[o++] = s.a;
    d[o++] = s.gravity;
    d[o++] = Math.max(MIN_DRAG, s.drag);
    d[o++] = s.sprite;
    d[o] = s.stretch;
    this.dirty.mark(slot);
  }

  /** Send this frame's new particles to the GPU. */
  flush(): void {
    this.dirty.flush(this.upload);
  }

  clear(): void {
    this.data.fill(0);
    this.ring.reset();
    this.buffer.clearUpdateRanges();
    this.buffer.needsUpdate = true;
  }

  dispose(): void {
    this.env.root.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }

  private readonly upload = (start: number, count: number): void => {
    this.buffer.addUpdateRange(start * STRIDE, count * STRIDE);
    this.buffer.needsUpdate = true;
  };
}

function buildMaterial(
  env: FxEnv,
  buffer: THREE.InstancedInterleavedBuffer,
  options: ParticlePoolOptions,
): THREE.MeshBasicNodeMaterial {
  const aOrigin: TslNode = instancedBufferAttribute(buffer, 'vec4', STRIDE, 0);
  const aVelocity: TslNode = instancedBufferAttribute(buffer, 'vec4', STRIDE, 4);
  const aShape: TslNode = instancedBufferAttribute(buffer, 'vec4', STRIDE, 8);
  const aColor: TslNode = instancedBufferAttribute(buffer, 'vec4', STRIDE, 12);
  const aPhysics: TslNode = instancedBufferAttribute(buffer, 'vec4', STRIDE, 16);

  const age: TslNode = env.time.sub(aOrigin.w);
  const life: TslNode = aVelocity.w;
  const progress: TslNode = age.div(max(life, 1e-4)).clamp(0, 1);
  const alive: TslNode = select(age.greaterThanEqual(0).and(age.lessThan(life)), float(1), float(0));

  // Motion under linear drag k toward the wind, plus gravity:
  //   x(t) = x0 + v0 (1 - e^-kt)/k + (wind + g/k) (t - (1 - e^-kt)/k)
  const drag: TslNode = aPhysics.y;
  const decay: TslNode = exp(drag.mul(age).negate());
  const reach: TslNode = decay.oneMinus().div(drag);
  const terminal: TslNode = vec3(0, aPhysics.x.negate(), 0).div(drag).add(env.windNode);
  const centre: TslNode = aOrigin.xyz.add(aVelocity.xyz.mul(reach)).add(terminal.mul(age.sub(reach)));
  const velocity: TslNode = aVelocity.xyz.mul(decay).add(terminal.mul(decay.oneMinus()));

  const growth: TslNode = progress.oneMinus().pow2().oneMinus();
  const size: TslNode = mix(aShape.x, aShape.y, growth).mul(alive);
  const corner: TslNode = uv().sub(0.5);

  const angle: TslNode = aShape.z.add(aShape.w.mul(age));
  const cosA: TslNode = cos(angle);
  const sinA: TslNode = sin(angle);
  const right: TslNode = cameraWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz;
  const up: TslNode = cameraWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz;
  const facing: TslNode = right
    .mul(corner.x.mul(cosA).sub(corner.y.mul(sinA)))
    .add(up.mul(corner.x.mul(sinA).add(corner.y.mul(cosA))))
    .mul(size);

  const speed: TslNode = length(velocity);
  const axis: TslNode = velocity.div(max(speed, 1e-4));
  const side: TslNode = normalize(cross(axis, cameraPosition.sub(centre)).add(vec3(1e-5, 0, 0)));
  const streak: TslNode = max(size, speed.mul(aPhysics.w).mul(alive));
  // The head of a streak sits on the particle and the tail trails behind it.
  const stretched: TslNode = axis.mul(corner.y.sub(0.5).mul(streak)).add(side.mul(corner.x.mul(size)));

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: options.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    fog: !options.additive,
  });
  material.positionNode = centre.add(select(aPhysics.w.greaterThan(0), stretched, facing));

  const cell: TslNode = aPhysics.z;
  const column: TslNode = mod(cell, SPRITE_GRID);
  const row: TslNode = floor(cell.div(SPRITE_GRID));
  const sheetUv: TslNode = varying(
    vec2(column.add(uv().x).div(SPRITE_GRID), float(1).sub(row.add(float(1).sub(uv().y)).div(SPRITE_GRID))),
  );
  const fade: TslNode = smoothstep(0, FADE_IN_SECONDS, age).mul(pow(progress.oneMinus(), options.fadePower));
  const near: TslNode = smoothstep(NEAR_FADE_START, NEAR_FADE_END, length(cameraPosition.sub(centre)));
  const tint: TslNode = varying(vec4(aColor.rgb, aColor.a.mul(fade).mul(near)));
  const sample: TslNode = texture(options.atlas, sheetUv);
  material.colorNode = vec4(tint.rgb.mul(sample.rgb), tint.a.mul(sample.a));
  material.alphaTest = 0.004;
  return material;
}
