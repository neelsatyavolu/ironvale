import * as THREE from 'three/webgpu';
import { float, floor, instancedBufferAttribute, mod, smoothstep, texture, uv, varying, vec2, vec4 } from 'three/tsl';
import { RingPool } from './pool';
import { RENDER_ORDER, randRange, type FxEnv, type FxModule, type TslNode } from './shared';
import { createDecalSheet, DECAL_GRID, DECAL_ROW, type DecalKind } from './decal-sheet';

const CAPACITY = 200;
/** Seconds a hole stays at full strength, then the time it takes to fade. */
const HOLD_SECONDS = 36;
const FADE_SECONDS = 4;
/** When the pool is full, holes this many shots from being reused start fading early. */
const RETIRE_AHEAD = 12;
const RETIRE_SECONDS = 0.8;
/** Distance off the surface, on top of the depth bias, so holes do not flicker. */
const SURFACE_OFFSET = 0.004;
/** Quad size in metres, smallest and largest, for each kind of hole. */
const SIZES: Readonly<Record<DecalKind, readonly [number, number]>> = {
  masonry: [0.11, 0.17],
  metal: [0.05, 0.068],
  wood: [0.07, 0.095],
  soft: [0.14, 0.21],
};
const FORWARD = new THREE.Vector3(0, 0, 1);
const STRIDE = 4;

/** Pooled bullet holes: lit quads laid on the surface that was hit. */
export class Decals implements FxModule {
  private readonly atlas = createDecalSheet();
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshStandardNodeMaterial;
  /** Per hole: sheet cell, fade start, fade end, metalness. */
  private readonly info = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * STRIDE), STRIDE);
  private readonly ring = new RingPool(CAPACITY);
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly facing = new THREE.Quaternion();
  private readonly roll = new THREE.Quaternion();
  private dirty = false;

  constructor(private readonly env: FxEnv) {
    this.material = this.buildMaterial();
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.material, CAPACITY);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = RENDER_ORDER.decals;
    this.hideAll();
    env.root.add(this.mesh);
  }

  /** Lay a hole on a surface. `scale` shrinks it for pellets. */
  add(kind: DecalKind, point: THREE.Vector3, normal: THREE.Vector3, scale: number): void {
    const now = this.env.now;
    const data = this.info.array as Float32Array;
    if (this.ring.wrapped) {
      // Fade out the holes that are about to be reused instead of letting them pop.
      const retiring = this.ring.peek(RETIRE_AHEAD) * STRIDE;
      if (data[retiring + 1]! > now) {
        data[retiring + 1] = now;
        data[retiring + 2] = now + RETIRE_SECONDS;
      }
    }
    const slot = this.ring.next();
    const [min, max] = SIZES[kind];
    const size = randRange(min, max) * scale;
    this.facing.setFromUnitVectors(FORWARD, normal);
    this.roll.setFromAxisAngle(FORWARD, randRange(0, Math.PI * 2));
    this.facing.multiply(this.roll);
    this.position.copy(point).addScaledVector(normal, SURFACE_OFFSET);
    this.matrix.compose(this.position, this.facing, this.scale.set(size, size, 1));
    this.mesh.setMatrixAt(slot, this.matrix);

    const o = slot * STRIDE;
    data[o] = DECAL_ROW[kind] * DECAL_GRID + Math.floor(Math.random() * DECAL_GRID);
    data[o + 1] = now + HOLD_SECONDS;
    data[o + 2] = now + HOLD_SECONDS + FADE_SECONDS;
    data[o + 3] = kind === 'metal' ? 1 : 0;
    this.dirty = true;
  }

  update(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.info.needsUpdate = true;
  }

  clear(): void {
    this.ring.reset();
    this.hideAll();
  }

  dispose(): void {
    this.env.root.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.atlas.dispose();
    this.mesh.dispose();
  }

  private hideAll(): void {
    this.matrix.makeScale(0, 0, 0);
    for (let i = 0; i < CAPACITY; i++) this.mesh.setMatrixAt(i, this.matrix);
    (this.info.array as Float32Array).fill(0);
    this.dirty = true;
  }

  private buildMaterial(): THREE.MeshStandardNodeMaterial {
    const aInfo: TslNode = instancedBufferAttribute(this.info, 'vec4');
    const cell: TslNode = aInfo.x;
    const column: TslNode = mod(cell, DECAL_GRID);
    const row: TslNode = floor(cell.div(DECAL_GRID));
    const sheetUv: TslNode = varying(
      vec2(column.add(uv().x).div(DECAL_GRID), float(1).sub(row.add(float(1).sub(uv().y)).div(DECAL_GRID))),
    );
    const strength: TslNode = varying(smoothstep(aInfo.y, aInfo.z, this.env.time).oneMinus());
    const metal: TslNode = varying(aInfo.w);
    const sample: TslNode = texture(this.atlas, sheetUv);

    const material = new THREE.MeshStandardNodeMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      roughness: 0.92,
      metalness: 0,
    });
    material.colorNode = vec4(sample.rgb, sample.a.mul(strength));
    material.metalnessNode = metal.mul(0.85);
    material.roughnessNode = float(0.92).sub(metal.mul(0.5));
    material.alphaTest = 0.02;
    return material;
  }
}
