import * as THREE from 'three/webgpu';
import { float, instancedBufferAttribute, mix, positionGeometry, step, varying, vec3 } from 'three/tsl';
import type { CasingKind, GameEvents } from '../game/contracts';
import { CASING_TUNING, createCasingBody, stepCasing, type CasingBody, type GroundProbe } from './casing-physics';
import { randRange, type FxEnv, type FxModule, type TslNode } from './shared';

const CAPACITY = 96;
/** Fewest casings kept on the ground at the lowest particle setting. */
const MIN_LIVE = 16;
/** Radius and length in metres, a touch over life size so they read on screen. */
const SIZES: Readonly<Record<CasingKind, readonly [number, number]>> = {
  pistol: [0.0055, 0.021],
  rifle: [0.0054, 0.05],
  shotgun: [0.011, 0.074],
  // The Garand's en-bloc clip: a stubby steel block, drawn as a short wide casing.
  clip: [0.012, 0.03],
};
const REST_MIN_SECONDS = 10;
const REST_MAX_SECONDS = 20;
const SHRINK_SECONDS = 0.6;
/** A casing still in the air after this long has left the level. */
const MAX_FLIGHT_SECONDS = 6;
const SPIN_KEPT_ON_BOUNCE = 0.55;
const AXIS_Y = new THREE.Vector3(0, 1, 0);

interface Casing {
  readonly body: CasingBody;
  readonly orientation: THREE.Quaternion;
  readonly spinAxis: THREE.Vector3;
  spinRate: number;
  kind: CasingKind;
  active: boolean;
  birth: number;
  /** Effect-clock time at which a resting casing starts to shrink away. */
  fadeAt: number;
}

/** Spent casings: instanced cylinders that tumble, bounce and lie on the ground for a while. */
export class Casings implements FxModule {
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshStandardNodeMaterial;
  /** 1 for a shotgun hull, 0 for brass. */
  private readonly hull = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY), 1);
  private readonly casings: Casing[] = [];
  private cursor = 0;
  private live = 0;
  private readonly unsubscribe: () => void;
  private readonly landed: GameEvents['casingLanded'] = {
    kind: 'rifle',
    position: new THREE.Vector3(),
    surface: 'concrete',
  };

  private readonly matrix = new THREE.Matrix4();
  private readonly scale = new THREE.Vector3();
  private readonly turn = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();
  private readonly probe: GroundProbe = (origin, direction, maxDistance) =>
    this.env.ctx.world.raycast(origin, direction, maxDistance);

  constructor(private readonly env: FxEnv) {
    for (let i = 0; i < CAPACITY; i++) {
      this.casings.push({
        body: createCasingBody(),
        orientation: new THREE.Quaternion(),
        spinAxis: new THREE.Vector3(1, 0, 0),
        spinRate: 0,
        kind: 'rifle',
        active: false,
        birth: 0,
        fadeAt: 0,
      });
    }
    this.material = this.buildMaterial();
    this.mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 10, 1), this.material, CAPACITY);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.matrix.makeScale(0, 0, 0);
    for (let i = 0; i < CAPACITY; i++) this.mesh.setMatrixAt(i, this.matrix);
    env.root.add(this.mesh);
    this.unsubscribe = env.ctx.events.on('casingEjected', this.onEjected);
  }

  update(dt: number): void {
    if (this.live === 0) return;
    const now = this.env.now;
    let changed = false;
    for (let i = 0; i < CAPACITY; i++) {
      const casing = this.casings[i]!;
      if (!casing.active) continue;
      const body = casing.body;
      const radius = SIZES[casing.kind][0];
      if (!body.resting) {
        const result = stepCasing(body, dt, this.probe, radius, CASING_TUNING);
        this.turn.setFromAxisAngle(casing.spinAxis, casing.spinRate * dt);
        casing.orientation.premultiply(this.turn);
        if (result !== 'flying') this.onContact(casing, result === 'landed');
        if (body.resting) this.settle(casing, now);
        else if (now - casing.birth > MAX_FLIGHT_SECONDS) this.retire(casing);
        this.write(i, casing, 1);
        changed = true;
      } else if (now >= casing.fadeAt) {
        const remaining = 1 - (now - casing.fadeAt) / SHRINK_SECONDS;
        if (remaining <= 0) this.retire(casing);
        this.write(i, casing, Math.max(0, remaining));
        changed = true;
      }
    }
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.matrix.makeScale(0, 0, 0);
    for (let i = 0; i < CAPACITY; i++) {
      this.casings[i]!.active = false;
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.live = 0;
    this.cursor = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.unsubscribe();
    this.env.root.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }

  private readonly onEjected = (event: GameEvents['casingEjected']): void => {
    if (!this.env.live) return;
    // Lower particle settings keep fewer casings around; the oldest is reused first.
    const limit = Math.max(MIN_LIVE, Math.round(CAPACITY * this.env.particleDensity));
    const slot = this.cursor % limit;
    this.cursor = (slot + 1) % limit;
    const casing = this.casings[slot]!;
    if (!casing.active) this.live++;
    casing.active = true;
    casing.kind = event.kind;
    casing.birth = this.env.now;
    casing.body.position.copy(event.position);
    casing.body.velocity.copy(event.velocity);
    casing.body.bounces = 0;
    casing.body.landed = false;
    casing.body.resting = false;
    casing.body.surface = null;
    casing.spinAxis.set(randRange(-1, 1), randRange(-1, 1), randRange(-1, 1)).normalize();
    casing.spinRate = randRange(14, 34);
    casing.orientation.setFromAxisAngle(casing.spinAxis, randRange(0, Math.PI * 2));
    (this.hull.array as Float32Array)[slot] = event.kind === 'shotgun' ? 1 : 0;
    this.hull.needsUpdate = true;
    this.write(slot, casing, 1);
    this.mesh.instanceMatrix.needsUpdate = true;
  };

  /** A contact knocks the tumble onto a new axis and takes some of it away. */
  private onContact(casing: Casing, firstGroundContact: boolean): void {
    casing.spinAxis.set(randRange(-1, 1), randRange(-1, 1), randRange(-1, 1)).normalize();
    casing.spinRate *= SPIN_KEPT_ON_BOUNCE;
    if (!firstGroundContact) return;
    this.landed.kind = casing.kind;
    this.landed.position.copy(casing.body.position);
    this.landed.surface = casing.body.surface ?? 'concrete';
    this.env.ctx.events.emit('casingLanded', this.landed);
  }

  /** Lay the casing on its side where it stopped. */
  private settle(casing: Casing, now: number): void {
    const axis = this.axis.copy(AXIS_Y).applyQuaternion(casing.orientation);
    axis.y = 0;
    if (axis.lengthSq() < 1e-4) axis.set(1, 0, 0);
    casing.orientation.setFromUnitVectors(AXIS_Y, axis.normalize());
    casing.spinRate = 0;
    casing.fadeAt = now + randRange(REST_MIN_SECONDS, REST_MAX_SECONDS);
  }

  private retire(casing: Casing): void {
    if (!casing.active) return;
    casing.active = false;
    this.live--;
  }

  private write(index: number, casing: Casing, shrink: number): void {
    const [radius, length] = SIZES[casing.kind];
    const visible = casing.active ? shrink : 0;
    this.scale.set(radius * visible, length * visible, radius * visible);
    this.matrix.compose(casing.body.position, casing.orientation, this.scale);
    this.mesh.setMatrixAt(index, this.matrix);
  }

  private buildMaterial(): THREE.MeshStandardNodeMaterial {
    const aHull: TslNode = instancedBufferAttribute(this.hull, 'float');
    // A shotgun shell is a plastic tube on a short brass head; everything else is all brass.
    const hull: TslNode = varying(aHull);
    const plastic: TslNode = hull.mul(step(-0.3, varying(positionGeometry.y)));
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.32, metalness: 1 });
    material.colorNode = mix(vec3(0.83, 0.61, 0.27), vec3(0.5, 0.045, 0.035), plastic);
    material.metalnessNode = float(1).sub(plastic);
    material.roughnessNode = mix(float(0.32), float(0.56), plastic);
    return material;
  }
}
