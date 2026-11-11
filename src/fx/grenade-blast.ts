import * as THREE from 'three/webgpu';
import type { Decals } from './decals';
import type { ParticlePool } from './particles';
import { scaledCount } from './pool';
import type { Rings } from './rings';
import { randomInCone, randRange, type FxEnv } from './shared';
import { SPRITE } from './textures';

const GRAVITY = 9.81;
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
/** Share of the particles drawn, by distance from the camera in metres. A blast is seen from far off, so it never drops to nothing. */
const LOD_STEPS: readonly (readonly [number, number])[] = [
  [60, 1],
  [140, 0.6],
];
const FAR_AMOUNT = 0.35;
/** The scorch mark is laid when there is ground this close under the blast. */
const SCORCH_REACH = 1.2;
/** Scales on the soft-ground decal (about 0.18 m across at scale 1), laid over each other: wide soot, then the burnt middle. */
const SCORCH_SCALES: readonly number[] = [24, 14, 8];
const SMOKE_ALBEDO = 0.1;
const DUST_ALBEDO: readonly [number, number, number] = [0.44, 0.4, 0.34];

/**
 * What a grenade blast looks like: a flash, a short fireball, rising smoke, a
 * ring of dust along the ground, sparks, thrown debris and a scorch mark.
 * Everything goes through the shared particle pools, so nothing new has to be
 * compiled when the first one goes off.
 */
export class GrenadeBlast {
  private readonly direction = new THREE.Vector3();
  private readonly lift = new THREE.Vector3();
  private readonly smokeLight = new THREE.Color();
  private readonly dustLight = new THREE.Color();

  constructor(
    private readonly env: FxEnv,
    private readonly lit: ParticlePool,
    private readonly glow: ParticlePool,
    private readonly rings: Rings,
    private readonly decals: Decals,
  ) {}

  emit(point: THREE.Vector3): void {
    const env = this.env;
    const distance = env.camera.position.distanceTo(point);
    let amount = FAR_AMOUNT;
    for (const [limit, scale] of LOD_STEPS) {
      if (distance < limit) {
        amount = scale;
        break;
      }
    }
    amount *= env.particleDensity;

    const sun = env.sunAt(this.lift.copy(point).addScaledVector(UP, 0.3), null);
    env.shade(SMOKE_ALBEDO, SMOKE_ALBEDO, SMOKE_ALBEDO, sun, this.smokeLight);
    env.shade(DUST_ALBEDO[0], DUST_ALBEDO[1], DUST_ALBEDO[2], sun, this.dustLight);

    // The flash and the scorch mark are the blast itself: they do not thin out with the particle setting.
    this.flash(point);
    const ground = env.ctx.world.raycast(this.lift, DOWN, SCORCH_REACH + 0.3);
    if (ground) {
      for (const scale of SCORCH_SCALES) this.decals.add('soft', ground.point, ground.normal, scale);
      this.rings.add(ground.point, ground.normal, 0.8, 12, 0.4, 0.55, 0);
    }
    this.fireball(point, amount);
    this.smoke(point, amount);
    this.dustRing(point, amount);
    this.sparks(point, amount);
    this.debris(point, amount);
  }

  private count(base: number, amount: number): number {
    return scaledCount(base, amount, Math.random());
  }

  private flash(point: THREE.Vector3): void {
    const s = this.glow.spawn;
    s.x = point.x;
    s.y = point.y + 0.35;
    s.z = point.z;
    s.vx = s.vy = s.vz = 0;
    s.rotation = randRange(0, Math.PI * 2);
    s.spin = 0;
    s.gravity = 0;
    s.drag = 1;
    s.stretch = 0;
    s.a = 1;
    s.life = 0.1;
    s.size = 3.2;
    s.sizeEnd = 6.5;
    s.r = 9;
    s.g = 7;
    s.b = 4.6;
    s.sprite = SPRITE.glow;
    this.glow.emit();
    s.life = 0.14;
    s.size = 2.2;
    s.sizeEnd = 5;
    s.r = 14;
    s.g = 9.5;
    s.b = 5;
    s.sprite = SPRITE.flare;
    this.glow.emit();
  }

  /** Burning gas: bright, rolling, gone in under half a second. */
  private fireball(point: THREE.Vector3, amount: number): void {
    const s = this.glow.spawn;
    for (let i = this.count(16, amount); i > 0; i--) {
      const dir = randomInCone(UP, 1, this.direction);
      const launch = randRange(1.5, 7);
      s.x = point.x + dir.x * 0.25;
      s.y = point.y + 0.2 + dir.y * 0.25;
      s.z = point.z + dir.z * 0.25;
      s.vx = dir.x * launch;
      s.vy = dir.y * launch;
      s.vz = dir.z * launch;
      s.life = randRange(0.24, 0.5);
      s.size = randRange(0.8, 1.3);
      s.sizeEnd = s.size * randRange(2, 2.8);
      s.rotation = randRange(0, Math.PI * 2);
      s.spin = randRange(-1.5, 1.5);
      const heat = randRange(0.55, 1);
      s.r = 5.2 * heat;
      s.g = 2.1 * heat * heat;
      s.b = 0.42 * heat * heat * heat;
      s.a = 0.9;
      s.sprite = Math.random() < 0.5 ? SPRITE.puffA : SPRITE.puffB;
      s.gravity = -2.5;
      s.drag = 5;
      s.stretch = 0;
      this.glow.emit();
    }
  }

  /** Dark smoke that climbs out of the fireball and drifts off on the wind. */
  private smoke(point: THREE.Vector3, amount: number): void {
    const s = this.lit.spawn;
    const light = this.smokeLight;
    for (let i = this.count(18, amount); i > 0; i--) {
      const dir = randomInCone(UP, 0.9, this.direction);
      const launch = randRange(1.2, 5.5);
      s.x = point.x + dir.x * 0.3;
      s.y = point.y + 0.25 + dir.y * 0.3;
      s.z = point.z + dir.z * 0.3;
      s.vx = dir.x * launch;
      s.vy = dir.y * launch + 0.6;
      s.vz = dir.z * launch;
      s.life = randRange(2.4, 4.4);
      s.size = randRange(0.7, 1.1);
      s.sizeEnd = randRange(2.6, 3.8);
      s.rotation = randRange(-0.6, 0.6);
      s.spin = randRange(-0.3, 0.3);
      const tone = randRange(0.7, 1.25);
      s.r = light.r * tone;
      s.g = light.g * tone;
      s.b = light.b * tone;
      s.a = randRange(0.5, 0.78);
      s.sprite = Math.random() < 0.5 ? SPRITE.puffA : SPRITE.puffB;
      s.gravity = -0.45;
      s.drag = randRange(2, 2.8);
      s.stretch = 0;
      this.lit.emit();
    }
  }

  /** Dust knocked outward along the ground by the pressure wave. */
  private dustRing(point: THREE.Vector3, amount: number): void {
    const s = this.lit.spawn;
    const light = this.dustLight;
    const total = this.count(24, amount);
    const turn = Math.random() * Math.PI * 2;
    for (let i = 0; i < total; i++) {
      const angle = turn + (i / total) * Math.PI * 2 + randRange(-0.12, 0.12);
      const launch = randRange(6, 11);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      s.x = point.x + cos * 0.4;
      s.y = point.y + 0.12;
      s.z = point.z + sin * 0.4;
      s.vx = cos * launch;
      s.vy = randRange(0.2, 1.3);
      s.vz = sin * launch;
      s.life = randRange(0.9, 1.7);
      s.size = randRange(0.4, 0.7);
      s.sizeEnd = randRange(1.7, 2.5);
      s.rotation = randRange(-0.6, 0.6);
      s.spin = randRange(-0.3, 0.3);
      const tone = randRange(0.85, 1.1);
      s.r = light.r * tone;
      s.g = light.g * tone;
      s.b = light.b * tone;
      s.a = randRange(0.3, 0.46);
      s.sprite = Math.random() < 0.5 ? SPRITE.puffA : SPRITE.puffB;
      s.gravity = 0.1;
      s.drag = randRange(3.2, 4.2);
      s.stretch = 0;
      this.lit.emit();
    }
  }

  /** Burning fragments: bright streaks thrown high and wide. */
  private sparks(point: THREE.Vector3, amount: number): void {
    const s = this.glow.spawn;
    for (let i = this.count(36, amount); i > 0; i--) {
      const dir = randomInCone(UP, 1, this.direction);
      const launch = randRange(8, 24);
      s.x = point.x;
      s.y = point.y + 0.15;
      s.z = point.z;
      s.vx = dir.x * launch;
      s.vy = dir.y * launch + 1.5;
      s.vz = dir.z * launch;
      s.life = randRange(0.3, 0.95);
      s.size = randRange(0.02, 0.036);
      s.sizeEnd = s.size * 0.5;
      s.rotation = 0;
      s.spin = 0;
      const heat = randRange(0.6, 1);
      s.r = 26 * heat;
      s.g = 13 * heat * heat;
      s.b = 3.4 * heat * heat * heat;
      s.a = 1;
      s.sprite = SPRITE.streak;
      s.gravity = GRAVITY;
      s.drag = 1.2;
      s.stretch = 0.03;
      this.glow.emit();
    }
  }

  /** Earth and chips thrown up and falling back. */
  private debris(point: THREE.Vector3, amount: number): void {
    const s = this.lit.spawn;
    const light = this.dustLight;
    for (let i = this.count(22, amount); i > 0; i--) {
      const dir = randomInCone(UP, 0.85, this.direction);
      const launch = randRange(4, 13);
      const grains = Math.random() < 0.4;
      s.x = point.x;
      s.y = point.y + 0.1;
      s.z = point.z;
      s.vx = dir.x * launch;
      s.vy = dir.y * launch;
      s.vz = dir.z * launch;
      s.life = randRange(0.8, 1.6);
      s.size = grains ? randRange(0.14, 0.24) : randRange(0.05, 0.11);
      s.sizeEnd = grains ? s.size * 2 : s.size;
      s.rotation = randRange(0, Math.PI * 2);
      s.spin = randRange(-9, 9);
      s.r = light.r * 0.45;
      s.g = light.g * 0.45;
      s.b = light.b * 0.45;
      s.a = 1;
      s.sprite = grains ? SPRITE.grains : Math.random() < 0.5 ? SPRITE.chipA : SPRITE.chipB;
      s.gravity = GRAVITY;
      s.drag = 0.5;
      s.stretch = 0;
      this.lit.emit();
    }
  }
}
