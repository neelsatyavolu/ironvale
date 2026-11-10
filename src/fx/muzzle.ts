import * as THREE from 'three/webgpu';
import { float, floor, instancedBufferAttribute, mix, mod, smoothstep, texture, uv, varying, vec2, vec3, vec4 } from 'three/tsl';
import type { GameEvents, WeaponClass } from '../game/contracts';
import { createFlashSheet, FLASH, FLASH_GRID } from './flash-sheet';
import type { ParticlePool } from './particles';
import { RingPool, scaledCount } from './pool';
import { leaveSurfaceDataAlone, randRange, RENDER_ORDER, type FxEnv, type FxModule, type TslNode } from './shared';
import { SPRITE } from './textures';

interface FlashShape {
  /** Sheet cell of the head-on view. */
  readonly cell: number;
  /** Width of the head-on flash in metres. */
  readonly size: number;
  /** Length of the tongue of flame along the barrel. */
  readonly length: number;
  /** Peak intensity of the light it throws. */
  readonly light: number;
}

const SHAPES: Readonly<Record<WeaponClass, FlashShape>> = {
  rifle: { cell: FLASH.star, size: 0.27, length: 0.4, light: 6 },
  carbine: { cell: FLASH.star, size: 0.23, length: 0.34, light: 5.5 },
  lmg: { cell: FLASH.star, size: 0.29, length: 0.42, light: 6.5 },
  sniper: { cell: FLASH.star, size: 0.34, length: 0.5, light: 7.5 },
  shotgun: { cell: FLASH.round, size: 0.42, length: 0.46, light: 9 },
  smg: { cell: FLASH.small, size: 0.16, length: 0.22, light: 4 },
  pistol: { cell: FLASH.small, size: 0.14, length: 0.18, light: 3.5 },
};

const MAX_FLASHES = 8;
/** One head-on quad and two crossed quads along the barrel. */
const QUADS = 3;
const FLASH_SECONDS = 0.04;
const LIGHT_SECONDS = 0.06;
const LIGHT_RANGE = 10;
const LIGHT_COLOR = 0xffb26b;
/** The local light sits ahead of the muzzle so it grazes the gun instead of burning it out. */
const LOCAL_LIGHT_AHEAD = 0.7;
const BOT_LIGHT_AHEAD = 0.3;
const BOT_LIGHTS = 2;
const BOT_EFFECT_RANGE = 70;
const BRIGHTNESS = 9;
/** Share of shots that show almost no flash, as happens in daylight. */
const DIM_SHOT_CHANCE = 0.2;
const HEAT_PER_SHOT = 1;
const MAX_HEAT = 12;
const HEAT_COOLING = 2.6;
/** Smoke keeps curling from a warm barrel for this long after the last shot. */
const LINGER_SECONDS = 1.3;
const LINGER_INTERVAL = 0.085;
const LINGER_MIN_HEAT = 1.5;

interface Flash {
  active: boolean;
  local: boolean;
  birth: number;
  /** Muzzle position and barrel direction: camera space for the local player, world space otherwise. */
  readonly position: THREE.Vector3;
  readonly direction: THREE.Vector3;
  size: number;
  length: number;
  cell: number;
  roll: number;
}

interface FlashLight {
  readonly light: THREE.PointLight;
  readonly position: THREE.Vector3;
  birth: number;
  peak: number;
  local: boolean;
}

/** Muzzle flash quads, the light they throw, and the smoke that follows. */
export class Muzzle implements FxModule {
  private readonly atlas = createFlashSheet();
  private readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  /** Per quad: sheet cell and brightness. */
  private readonly info = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FLASHES * QUADS * 2), 2);
  private readonly flashes: Flash[] = [];
  private readonly ring = new RingPool(MAX_FLASHES);
  private readonly lights: FlashLight[] = [];
  private nextBotLight = 0;
  private anyActive = false;
  private heat = 0;
  private sinceShot = Infinity;
  private lingerTimer = 0;
  /** Local muzzle in camera space, kept so lingering smoke leaves the gun where it is now. */
  private readonly localMuzzle = new THREE.Vector3();
  private readonly localDirection = new THREE.Vector3(0, 0, -1);
  private readonly unsubscribe: () => void;

  private readonly matrix = new THREE.Matrix4();
  private readonly muzzle = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly u = new THREE.Vector3();
  private readonly v = new THREE.Vector3();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly inverse = new THREE.Quaternion();
  private readonly smokeLight = new THREE.Color();

  constructor(
    private readonly env: FxEnv,
    private readonly lit: ParticlePool,
  ) {
    for (let i = 0; i < MAX_FLASHES; i++) {
      this.flashes.push({
        active: false,
        local: false,
        birth: 0,
        position: new THREE.Vector3(),
        direction: new THREE.Vector3(),
        size: 0,
        length: 0,
        cell: 0,
        roll: 0,
      });
    }
    this.material = this.buildMaterial();
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.material, MAX_FLASHES * QUADS);
    leaveSurfaceDataAlone(this.mesh, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = RENDER_ORDER.flash;
    this.matrix.makeScale(0, 0, 0);
    for (let i = 0; i < MAX_FLASHES * QUADS; i++) this.mesh.setMatrixAt(i, this.matrix);
    env.root.add(this.mesh);

    // The lights stay in the scene at zero intensity: adding or removing a light recompiles every lit material.
    for (let i = 0; i < 1 + BOT_LIGHTS; i++) {
      const light = new THREE.PointLight(LIGHT_COLOR, 0, LIGHT_RANGE, 2);
      env.root.add(light);
      this.lights.push({ light, position: new THREE.Vector3(), birth: -1, peak: 0, local: i === 0 });
    }
    this.unsubscribe = env.ctx.events.on('shotFired', this.onShot);
  }

  update(dt: number): void {
    const camera = this.env.camera;
    const now = this.env.now;
    if (this.anyActive) {
      this.anyActive = false;
      for (let i = 0; i < MAX_FLASHES; i++) {
        const flash = this.flashes[i]!;
        if (!flash.active) continue;
        const progress = (now - flash.birth) / FLASH_SECONDS;
        if (progress >= 1) {
          flash.active = false;
          this.hide(i);
          continue;
        }
        this.anyActive = true;
        this.place(i, flash, progress);
      }
      this.mesh.instanceMatrix.needsUpdate = true;
      this.info.needsUpdate = true;
    }

    for (const entry of this.lights) {
      if (entry.birth < 0) continue;
      const progress = (now - entry.birth) / LIGHT_SECONDS;
      if (progress >= 1) {
        entry.birth = -1;
        entry.light.intensity = 0;
        continue;
      }
      entry.light.intensity = entry.peak * (1 - progress) * (1 - progress);
      if (entry.local) entry.light.position.copy(entry.position).applyQuaternion(camera.quaternion).add(camera.position);
    }

    this.heat = Math.max(0, this.heat - HEAT_COOLING * dt);
    this.sinceShot += dt;
    if (this.heat > LINGER_MIN_HEAT && this.sinceShot > 0.1 && this.sinceShot < LINGER_SECONDS) {
      this.lingerTimer -= dt;
      if (this.lingerTimer <= 0) {
        this.lingerTimer = LINGER_INTERVAL;
        this.muzzle.copy(this.localMuzzle).applyQuaternion(camera.quaternion).add(camera.position);
        this.dir.copy(this.localDirection).applyQuaternion(camera.quaternion);
        this.smoke(this.muzzle, this.dir, scaledCount(1, this.env.particleDensity, Math.random()), 0.25, true);
      }
    }
  }

  clear(): void {
    for (let i = 0; i < MAX_FLASHES; i++) {
      this.flashes[i]!.active = false;
      this.hide(i);
    }
    for (const entry of this.lights) {
      entry.birth = -1;
      entry.light.intensity = 0;
    }
    this.anyActive = false;
    this.heat = 0;
    this.sinceShot = Infinity;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.unsubscribe();
    this.env.root.remove(this.mesh);
    for (const entry of this.lights) {
      this.env.root.remove(entry.light);
      entry.light.dispose();
    }
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.atlas.dispose();
    this.mesh.dispose();
  }

  private readonly onShot = (event: GameEvents['shotFired']): void => {
    if (!this.env.live) return;
    const camera = this.env.camera;
    const shape = SHAPES[event.weapon.weaponClass];
    if (!event.local && camera.position.distanceToSquared(event.muzzle) > BOT_EFFECT_RANGE * BOT_EFFECT_RANGE) return;

    const slot = this.ring.next();
    const flash = this.flashes[slot]!;
    const dim = Math.random() < DIM_SHOT_CHANCE ? 0.45 : 1;
    const scale = randRange(0.75, 1.25) * dim * (event.local ? 0.8 : 1);
    flash.active = true;
    flash.local = event.local;
    flash.birth = this.env.now;
    flash.size = shape.size * scale;
    flash.length = shape.length * scale;
    flash.cell = shape.cell;
    flash.roll = randRange(0, Math.PI * 2);
    flash.position.copy(event.muzzle);
    flash.direction.copy(event.direction);
    if (event.local) {
      // Keep the flash on the gun while the view turns.
      this.inverse.copy(camera.quaternion).invert();
      flash.position.sub(camera.position).applyQuaternion(this.inverse);
      flash.direction.applyQuaternion(this.inverse);
      this.localMuzzle.copy(flash.position);
      this.localDirection.copy(flash.direction);
      this.heat = Math.min(MAX_HEAT, this.heat + HEAT_PER_SHOT);
      this.sinceShot = 0;
    }
    this.anyActive = true;
    this.place(slot, flash, 0);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.info.needsUpdate = true;

    this.flashLight(event, shape.light * dim);
    const wisps = event.local ? 1 + (this.heat > 4 ? 1 : 0) : 1;
    this.smoke(event.muzzle, event.direction, scaledCount(wisps, this.env.particleDensity, Math.random()), 1, event.local);
  };

  private flashLight(event: GameEvents['shotFired'], peak: number): void {
    const camera = this.env.camera;
    let entry: FlashLight;
    if (event.local) {
      entry = this.lights[0]!;
    } else {
      entry = this.lights[1 + this.nextBotLight]!;
      this.nextBotLight = (this.nextBotLight + 1) % BOT_LIGHTS;
    }
    const ahead = event.local ? LOCAL_LIGHT_AHEAD : BOT_LIGHT_AHEAD;
    entry.light.position.copy(event.muzzle).addScaledVector(event.direction, ahead);
    entry.light.intensity = peak;
    entry.peak = peak;
    entry.birth = this.env.now;
    if (entry.local) {
      this.inverse.copy(camera.quaternion).invert();
      entry.position.copy(entry.light.position).sub(camera.position).applyQuaternion(this.inverse);
    }
  }

  /** Thin grey smoke that leaves the muzzle, slows and rises. */
  private smoke(muzzle: THREE.Vector3, direction: THREE.Vector3, count: number, push: number, local: boolean): void {
    if (count <= 0) return;
    const sun = local && this.env.ctx.player.indoors ? 0 : 1;
    const light = this.env.shade(0.7, 0.7, 0.72, sun, this.smokeLight);
    const s = this.lit.spawn;
    for (let i = 0; i < count; i++) {
      const speed = randRange(0.5, 1.8) * push;
      s.x = muzzle.x + direction.x * 0.05;
      s.y = muzzle.y + direction.y * 0.05;
      s.z = muzzle.z + direction.z * 0.05;
      s.vx = direction.x * speed + randRange(-0.15, 0.15);
      s.vy = direction.y * speed + randRange(0.05, 0.3);
      s.vz = direction.z * speed + randRange(-0.15, 0.15);
      s.life = randRange(0.9, 1.7);
      s.size = randRange(0.03, 0.05);
      s.sizeEnd = randRange(0.22, 0.36);
      s.rotation = randRange(0, Math.PI * 2);
      s.spin = randRange(-0.9, 0.9);
      s.r = light.r;
      s.g = light.g;
      s.b = light.b;
      s.a = randRange(0.14, 0.24);
      s.sprite = Math.random() < 0.6 ? SPRITE.wisp : SPRITE.puffA;
      s.gravity = -0.4;
      s.drag = 3.2;
      s.stretch = 0;
      this.lit.emit();
    }
  }

  private hide(index: number): void {
    this.matrix.makeScale(0, 0, 0);
    for (let q = 0; q < QUADS; q++) this.mesh.setMatrixAt(index * QUADS + q, this.matrix);
  }

  /** Write the three quads of one flash for its current age. */
  private place(index: number, flash: Flash, progress: number): void {
    const camera = this.env.camera;
    this.muzzle.copy(flash.position);
    this.dir.copy(flash.direction);
    if (flash.local) {
      this.muzzle.applyQuaternion(camera.quaternion).add(camera.position);
      this.dir.applyQuaternion(camera.quaternion);
    }
    const dir = this.dir.normalize();
    // Two axes across the barrel, rolled by a random angle.
    this.u.set(0, 1, 0);
    if (Math.abs(dir.y) > 0.99) this.u.set(1, 0, 0);
    this.u.cross(dir).normalize();
    this.v.crossVectors(dir, this.u);
    const cosR = Math.cos(flash.roll);
    const sinR = Math.sin(flash.roll);
    this.a.copy(this.u).multiplyScalar(cosR).addScaledVector(this.v, sinR);
    this.b.copy(this.v).multiplyScalar(cosR).addScaledVector(this.u, -sinR);

    const grow = 0.75 + 0.5 * progress;
    const brightness = (1 - progress) * (1 - progress * 0.5);
    const base = index * QUADS;
    const info = this.info.array as Float32Array;

    const size = flash.size * grow;
    this.matrix.makeBasis(this.a, this.b, dir).scale(this.u.set(size, size, 1));
    this.matrix.setPosition(
      this.muzzle.x + dir.x * 0.04,
      this.muzzle.y + dir.y * 0.04,
      this.muzzle.z + dir.z * 0.04,
    );
    this.mesh.setMatrixAt(base, this.matrix);
    info[base * 2] = flash.cell;
    info[base * 2 + 1] = brightness;

    const length = flash.length * grow;
    const width = flash.size * 0.62 * grow;
    for (let q = 1; q < QUADS; q++) {
      const across = q === 1 ? this.a : this.b;
      const facing = q === 1 ? this.b : this.a;
      this.matrix.makeBasis(across, dir, facing).scale(this.u.set(width, length, 1));
      this.matrix.setPosition(
        this.muzzle.x + dir.x * length * 0.46,
        this.muzzle.y + dir.y * length * 0.46,
        this.muzzle.z + dir.z * length * 0.46,
      );
      this.mesh.setMatrixAt(base + q, this.matrix);
      info[(base + q) * 2] = FLASH.jet;
      info[(base + q) * 2 + 1] = brightness * 0.8;
    }
  }

  private buildMaterial(): THREE.MeshBasicNodeMaterial {
    const aInfo: TslNode = instancedBufferAttribute(this.info, 'vec2');
    const cell: TslNode = aInfo.x;
    const column: TslNode = mod(cell, FLASH_GRID);
    const row: TslNode = floor(cell.div(FLASH_GRID));
    const sheetUv: TslNode = varying(
      vec2(column.add(uv().x).div(FLASH_GRID), float(1).sub(row.add(float(1).sub(uv().y)).div(FLASH_GRID))),
    );
    const brightness: TslNode = varying(aInfo.y);
    const mask: TslNode = texture(this.atlas, sheetUv).a;
    // Orange at the ragged edge, pale yellow-white in the core.
    const colour: TslNode = mix(vec3(1, 0.36, 0.08), vec3(1, 0.86, 0.6), smoothstep(0.2, 0.85, mask));

    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    // Additive blending scales by alpha, so the mask goes there and empty texels can be discarded.
    material.colorNode = vec4(colour.mul(brightness).mul(BRIGHTNESS), mask);
    material.alphaTest = 0.01;
    return material;
  }
}
