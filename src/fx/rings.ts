import * as THREE from 'three/webgpu';
import {
  abs,
  cross,
  float,
  instancedBufferAttribute,
  length,
  max,
  mix,
  normalize,
  pow,
  select,
  smoothstep,
  uv,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import { DirtyRange, RingPool } from './pool';
import { RENDER_ORDER, leaveSurfaceDataAlone, type FxEnv, type TslNode } from './shared';

/** Floats per ring: centre + birth, normal + life, start size, end size, opacity, spare. */
const STRIDE = 12;
const CAPACITY = 320;
/** Lift off the surface so the ring does not fight it for depth. */
const SURFACE_OFFSET = 0.012;

/**
 * Expanding rings lying flat on a surface: rain landing on the ground and
 * bullets hitting water. Animated in the shader from each ring's birth time.
 */
export class Rings {
  private readonly data = new Float32Array(CAPACITY * STRIDE);
  private readonly buffer = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
  private readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly ring = new RingPool(CAPACITY);
  private readonly dirty = new DirtyRange();

  constructor(private readonly env: FxEnv) {
    this.material = this.buildMaterial();
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    leaveSurfaceDataAlone(this.mesh, this.material);
    this.mesh.count = CAPACITY;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = RENDER_ORDER.rings;
    env.root.add(this.mesh);
  }

  /** Start a ring that grows from `size` to `sizeEnd` metres across over `life` seconds, after `delay`. */
  add(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    size: number,
    sizeEnd: number,
    life: number,
    alpha: number,
    delay: number,
  ): void {
    const slot = this.ring.next();
    const d = this.data;
    let o = slot * STRIDE;
    d[o++] = point.x;
    d[o++] = point.y;
    d[o++] = point.z;
    d[o++] = this.env.now + delay;
    d[o++] = normal.x;
    d[o++] = normal.y;
    d[o++] = normal.z;
    d[o++] = life;
    d[o++] = size;
    d[o++] = sizeEnd;
    d[o] = alpha;
    this.dirty.mark(slot);
  }

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

  private buildMaterial(): THREE.MeshBasicNodeMaterial {
    const aCentre: TslNode = instancedBufferAttribute(this.buffer, 'vec4', STRIDE, 0);
    const aNormal: TslNode = instancedBufferAttribute(this.buffer, 'vec4', STRIDE, 4);
    const aShape: TslNode = instancedBufferAttribute(this.buffer, 'vec4', STRIDE, 8);

    const age: TslNode = this.env.time.sub(aCentre.w);
    const life: TslNode = aNormal.w;
    const progress: TslNode = age.div(max(life, 1e-4)).clamp(0, 1);
    const alive: TslNode = select(age.greaterThanEqual(0).and(age.lessThan(life)), float(1), float(0));
    const normal: TslNode = aNormal.xyz;
    const helper: TslNode = select(abs(normal.y).lessThan(0.99), vec3(0, 1, 0), vec3(1, 0, 0));
    const tangent: TslNode = normalize(cross(helper, normal));
    const bitangent: TslNode = cross(normal, tangent);
    const size: TslNode = mix(aShape.x, aShape.y, progress.oneMinus().pow2().oneMinus()).mul(alive);
    const corner: TslNode = uv().sub(0.5);

    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    material.positionNode = aCentre.xyz
      .add(normal.mul(SURFACE_OFFSET))
      .add(tangent.mul(corner.x).add(bitangent.mul(corner.y)).mul(size));

    const radius: TslNode = length(uv().sub(0.5)).mul(2);
    const band: TslNode = smoothstep(0.6, 0.84, radius).mul(smoothstep(0.9, 1, radius).oneMinus());
    const strength: TslNode = varying(aShape.z.mul(pow(progress.oneMinus(), 1.5)));
    // Disturbed water shows the sky and a little sun.
    const sheen: TslNode = this.env.ambientLightNode.mul(1.5).add(this.env.sunLightNode.mul(0.5));
    material.colorNode = vec4(sheen, band.mul(strength));
    material.alphaTest = 0.004;
    return material;
  }
}
