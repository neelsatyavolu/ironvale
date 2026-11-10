import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  cross,
  exp,
  float,
  instancedBufferAttribute,
  length,
  max,
  min,
  mix,
  normalize,
  select,
  smoothstep,
  uv,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import type { GameEvents } from '../game/contracts';
import { DirtyRange, RingPool } from './pool';
import { RENDER_ORDER, leaveSurfaceDataAlone, type FxEnv, type FxModule, type TslNode } from './shared';
import { showLocalTracer, tracerLength, visibleTracerSpeed } from './tracer-math';

/** Floats per tracer: start + birth, direction + path length, speed, streak length, width, brightness. */
const STRIDE = 12;
const CAPACITY = 96;
const WIDTH = 0.03;
/** Keeps a distant streak about a pixel and a half wide instead of letting it vanish. */
const MIN_WIDTH_PER_METRE = 0.0017;
/** The player's own tracer starts ahead of the muzzle so it does not flash across the view. */
const LOCAL_START_AHEAD = 2.2;
const MIN_PATH = 1.5;

/** Bullet streaks. Each is written once and flown by the vertex shader. */
export class Tracers implements FxModule {
  private readonly data = new Float32Array(CAPACITY * STRIDE);
  private readonly buffer = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly ring = new RingPool(CAPACITY);
  private readonly dirty = new DirtyRange();
  private readonly unsubscribe: () => void;
  private readonly direction = new THREE.Vector3();
  private readonly start = new THREE.Vector3();
  private localRounds = 0;

  constructor(private readonly env: FxEnv) {
    this.material = this.buildMaterial();
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    leaveSurfaceDataAlone(this.mesh, this.material);
    this.mesh.count = CAPACITY;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = RENDER_ORDER.tracers;
    env.root.add(this.mesh);
    this.unsubscribe = env.ctx.events.on('bulletTrace', this.onTrace);
  }

  /** Fly a streak from `from` along `direction` (unit length) for `distance` metres. */
  add(
    from: THREE.Vector3,
    direction: THREE.Vector3,
    distance: number,
    speed: number,
    streak: number,
    brightness: number,
  ): void {
    const slot = this.ring.next();
    const d = this.data;
    let o = slot * STRIDE;
    d[o++] = from.x;
    d[o++] = from.y;
    d[o++] = from.z;
    d[o++] = this.env.now;
    d[o++] = direction.x;
    d[o++] = direction.y;
    d[o++] = direction.z;
    d[o++] = distance;
    d[o++] = speed;
    d[o++] = streak;
    d[o++] = WIDTH;
    d[o] = brightness;
    this.dirty.mark(slot);
  }

  update(): void {
    this.dirty.flush(this.upload);
  }

  clear(): void {
    this.data.fill(0);
    this.ring.reset();
    this.localRounds = 0;
    this.buffer.clearUpdateRanges();
    this.buffer.needsUpdate = true;
  }

  dispose(): void {
    this.unsubscribe();
    this.env.root.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
  }

  private readonly onTrace = (event: GameEvents['bulletTrace']): void => {
    if (!this.env.live) return;
    if (event.local && !showLocalTracer(this.localRounds++, event.weapon.pellets)) return;
    const direction = this.direction.subVectors(event.to, event.from);
    let distance = direction.length();
    if (distance < MIN_PATH) return;
    direction.divideScalar(distance);
    this.start.copy(event.from);
    if (event.local) {
      const skip = Math.min(LOCAL_START_AHEAD, distance * 0.3);
      this.start.addScaledVector(direction, skip);
      distance -= skip;
    }
    const speed = visibleTracerSpeed(event.weapon.muzzleVelocity, distance);
    this.add(this.start, direction, distance, speed, tracerLength(speed, distance), event.local ? 0.75 : 1);
  };

  private readonly upload = (start: number, count: number): void => {
    this.buffer.addUpdateRange(start * STRIDE, count * STRIDE);
    this.buffer.needsUpdate = true;
  };

  private buildMaterial(): THREE.MeshBasicNodeMaterial {
    const aStart: TslNode = instancedBufferAttribute(this.buffer, 'vec4', STRIDE, 0);
    const aPath: TslNode = instancedBufferAttribute(this.buffer, 'vec4', STRIDE, 4);
    const aShape: TslNode = instancedBufferAttribute(this.buffer, 'vec4', STRIDE, 8);

    const age: TslNode = this.env.time.sub(aStart.w);
    const travelled: TslNode = aShape.x.mul(age);
    const head: TslNode = min(travelled, aPath.w);
    const tail: TslNode = travelled.sub(aShape.y).clamp(0, aPath.w);
    const alive: TslNode = select(age.greaterThanEqual(0).and(tail.lessThan(aPath.w)), float(1), float(0));
    const along: TslNode = mix(tail, head, uv().y);
    const point: TslNode = aStart.xyz.add(aPath.xyz.mul(along));
    const toEye: TslNode = cameraPosition.sub(point);
    const side: TslNode = normalize(cross(aPath.xyz, toEye).add(vec3(1e-5, 0, 0)));
    const width: TslNode = max(aShape.z, length(toEye).mul(MIN_WIDTH_PER_METRE)).mul(alive);

    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    material.positionNode = point.add(side.mul(uv().x.sub(0.5).mul(width)));

    // Bright core with a soft skirt across the width; the tail thins out behind the head.
    const across: TslNode = uv().x.sub(0.5).mul(2).abs();
    const core: TslNode = exp(across.mul(across).mul(-14)).add(exp(across.mul(across).mul(-3)).mul(0.22));
    const lengthwise: TslNode = smoothstep(0, 0.75, uv().y).mul(smoothstep(0.94, 1, uv().y).oneMinus().mul(0.5).add(0.5));
    const brightness: TslNode = varying(aShape.w);
    const edge: TslNode = smoothstep(0.82, 1, across).oneMinus();
    material.colorNode = vec4(vec3(20, 11, 4).mul(brightness), core.mul(lengthwise).mul(edge));
    material.alphaTest = 0.004;
    return material;
  }
}
