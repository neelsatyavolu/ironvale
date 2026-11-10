import * as THREE from 'three/webgpu';
import type { ParticlePool } from './particles';
import { scaledCount } from './pool';
import type { Rings } from './rings';
import { randomInCone, randRange, type FxEnv } from './shared';
import { SPRITE } from './textures';

const GRAVITY = 9.81;

/**
 * The building blocks impacts are made of: dust clouds, jets, tumbling
 * fragments, grit, sparks, shards, leaves and water. `amount` scales how many
 * particles each call launches (quality setting, distance, pellets).
 */
export class ImpactEmitters {
  /** Light on this impact's dust and on its solid debris. Set before emitting. */
  readonly dustLight = new THREE.Color();
  readonly debrisLight = new THREE.Color();
  private readonly direction = new THREE.Vector3();

  constructor(
    private readonly env: FxEnv,
    private readonly lit: ParticlePool,
    private readonly glow: ParticlePool,
    private readonly rings: Rings,
  ) {}

  private count(base: number, amount: number): number {
    return scaledCount(base, amount, Math.random());
  }

  /** Slow, lingering cloud that the wind carries off. `size` is how wide it ends up, in metres. */
  dust(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    amount: number,
    base: number,
    speed: number,
    size: number,
    life: number,
    alpha: number,
  ): void {
    const s = this.lit.spawn;
    const light = this.dustLight;
    for (let i = this.count(base, amount); i > 0; i--) {
      const dir = randomInCone(normal, 0.55, this.direction);
      const launch = speed * randRange(0.3, 1);
      s.x = point.x + normal.x * 0.04;
      s.y = point.y + normal.y * 0.04;
      s.z = point.z + normal.z * 0.04;
      s.vx = dir.x * launch;
      s.vy = dir.y * launch;
      s.vz = dir.z * launch;
      s.life = life * randRange(0.7, 1.3);
      s.size = size * randRange(0.3, 0.42);
      s.sizeEnd = size * randRange(0.85, 1.3);
      // Puffs are shaded from above, so they stay roughly upright.
      s.rotation = randRange(-0.6, 0.6);
      s.spin = randRange(-0.25, 0.25);
      const tone = randRange(0.85, 1.1);
      s.r = light.r * tone;
      s.g = light.g * tone;
      s.b = light.b * tone;
      s.a = alpha * randRange(0.75, 1);
      s.sprite = Math.random() < 0.5 ? SPRITE.puffA : SPRITE.puffB;
      s.gravity = 0.1;
      s.drag = randRange(3, 4.6);
      s.stretch = 0;
      this.lit.emit();
    }
  }

  /** Dense, short jet straight off the surface in the first instant. */
  burst(
    point: THREE.Vector3,
    axis: THREE.Vector3,
    amount: number,
    base: number,
    speed: number,
    size: number,
    life: number,
    alpha: number,
  ): void {
    const s = this.lit.spawn;
    const light = this.dustLight;
    for (let i = this.count(base, amount); i > 0; i--) {
      const dir = randomInCone(axis, 0.3, this.direction);
      const launch = speed * randRange(0.5, 1);
      s.x = point.x + axis.x * 0.04;
      s.y = point.y + axis.y * 0.04;
      s.z = point.z + axis.z * 0.04;
      s.vx = dir.x * launch;
      s.vy = dir.y * launch;
      s.vz = dir.z * launch;
      s.life = life * randRange(0.75, 1.25);
      s.size = size * randRange(0.22, 0.35);
      s.sizeEnd = size * randRange(0.9, 1.3);
      s.rotation = randRange(-0.6, 0.6);
      s.spin = randRange(-0.5, 0.5);
      s.r = light.r * 0.9;
      s.g = light.g * 0.9;
      s.b = light.b * 0.9;
      s.a = alpha;
      s.sprite = SPRITE.puffB;
      s.gravity = 1.2;
      s.drag = 4.5;
      s.stretch = 0;
      this.lit.emit();
    }
  }

  /** Solid fragments that tumble and fall. */
  debris(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    amount: number,
    base: number,
    speed: number,
    size: number,
    sprite: number,
  ): void {
    const s = this.lit.spawn;
    const light = this.debrisLight;
    for (let i = this.count(base, amount); i > 0; i--) {
      const dir = randomInCone(normal, 0.85, this.direction);
      const launch = speed * randRange(0.3, 1);
      s.x = point.x + normal.x * 0.02;
      s.y = point.y + normal.y * 0.02;
      s.z = point.z + normal.z * 0.02;
      s.vx = dir.x * launch;
      s.vy = dir.y * launch + 0.6;
      s.vz = dir.z * launch;
      s.life = randRange(0.5, 0.95);
      s.size = size * randRange(0.5, 1.3);
      s.sizeEnd = s.size;
      s.rotation = randRange(0, Math.PI * 2);
      s.spin = randRange(-14, 14);
      // Fragments show their shaded side as often as their lit one, so they read darker than the dust.
      const tone = randRange(0.3, 0.85);
      s.r = light.r * tone;
      s.g = light.g * tone;
      s.b = light.b * tone;
      s.a = 1;
      s.sprite = sprite;
      s.gravity = GRAVITY;
      s.drag = 0.7;
      s.stretch = 0;
      this.lit.emit();
    }
  }

  /** Sprays of small grains; each sprite carries several. */
  grit(point: THREE.Vector3, axis: THREE.Vector3, amount: number, base: number, speed: number): void {
    const s = this.lit.spawn;
    const light = this.debrisLight;
    for (let i = this.count(base, amount); i > 0; i--) {
      const dir = randomInCone(axis, 0.6, this.direction);
      const launch = speed * randRange(0.45, 1);
      s.x = point.x + axis.x * 0.03;
      s.y = point.y + axis.y * 0.03;
      s.z = point.z + axis.z * 0.03;
      s.vx = dir.x * launch;
      s.vy = dir.y * launch;
      s.vz = dir.z * launch;
      s.life = randRange(0.6, 1.05);
      s.size = randRange(0.1, 0.16);
      s.sizeEnd = s.size * 2.4;
      s.rotation = randRange(0, Math.PI * 2);
      s.spin = randRange(-3, 3);
      s.r = light.r * 0.6;
      s.g = light.g * 0.6;
      s.b = light.b * 0.6;
      s.a = 1;
      s.sprite = SPRITE.grains;
      s.gravity = GRAVITY;
      s.drag = 1.1;
      s.stretch = 0;
      this.lit.emit();
    }
  }

  /** Thin, bright streaks that arc under gravity and die quickly. */
  sparks(point: THREE.Vector3, normal: THREE.Vector3, amount: number, base: number, sun: number): void {
    const s = this.glow.spawn;
    // Sparks read weaker in direct sun, so they are pushed a little harder there.
    const gain = 1 + sun * 0.6;
    for (let i = this.count(base, amount); i > 0; i--) {
      const dir = randomInCone(normal, 0.8, this.direction);
      const launch = randRange(4, 13);
      s.x = point.x + normal.x * 0.01;
      s.y = point.y + normal.y * 0.01;
      s.z = point.z + normal.z * 0.01;
      s.vx = dir.x * launch;
      s.vy = dir.y * launch + 0.8;
      s.vz = dir.z * launch;
      s.life = randRange(0.16, 0.55);
      s.size = randRange(0.016, 0.026);
      s.sizeEnd = s.size * 0.5;
      s.rotation = 0;
      s.spin = 0;
      const heat = randRange(0.6, 1);
      s.r = 22 * gain * heat;
      s.g = 12 * gain * heat * heat;
      s.b = 3.6 * gain * heat * heat * heat;
      s.a = 1;
      s.sprite = SPRITE.streak;
      s.gravity = GRAVITY;
      s.drag = 1.7;
      s.stretch = 0.03;
      this.glow.emit();
    }
  }

  /** One-frame flash at the strike point. */
  flare(point: THREE.Vector3, normal: THREE.Vector3, size: number): void {
    const s = this.glow.spawn;
    s.x = point.x + normal.x * 0.03;
    s.y = point.y + normal.y * 0.03;
    s.z = point.z + normal.z * 0.03;
    s.vx = 0;
    s.vy = 0;
    s.vz = 0;
    s.life = 0.07;
    s.size = size * randRange(0.8, 1.2);
    s.sizeEnd = s.size * 1.5;
    s.rotation = randRange(0, Math.PI * 2);
    s.spin = 0;
    s.r = 9;
    s.g = 6.5;
    s.b = 3.2;
    s.a = 1;
    s.sprite = SPRITE.flare;
    s.gravity = 0;
    s.drag = 1;
    s.stretch = 0;
    this.glow.emit();
  }

  shards(point: THREE.Vector3, normal: THREE.Vector3, amount: number, base: number, sun: number): void {
    this.debris(point, normal, amount, base, 3.6, 0.06, SPRITE.shard);
    if (sun === 0) return;
    // A few shards catch the sun as they turn.
    const s = this.glow.spawn;
    for (let i = this.count(3, amount); i > 0; i--) {
      const dir = randomInCone(normal, 0.85, this.direction);
      const launch = randRange(1.5, 3.6);
      s.x = point.x;
      s.y = point.y;
      s.z = point.z;
      s.vx = dir.x * launch;
      s.vy = dir.y * launch + 0.6;
      s.vz = dir.z * launch;
      s.life = randRange(0.2, 0.45);
      s.size = randRange(0.03, 0.05);
      s.sizeEnd = s.size * 0.3;
      s.rotation = 0;
      s.spin = 0;
      s.r = this.env.sunLight.r * 4;
      s.g = this.env.sunLight.g * 4;
      s.b = this.env.sunLight.b * 4;
      s.a = 1;
      s.sprite = SPRITE.glow;
      s.gravity = GRAVITY;
      s.drag = 0.7;
      s.stretch = 0;
      this.glow.emit();
    }
  }

  leaves(point: THREE.Vector3, axis: THREE.Vector3, amount: number, base: number): void {
    const s = this.lit.spawn;
    const light = this.debrisLight;
    for (let i = this.count(base, amount); i > 0; i--) {
      const dir = randomInCone(axis, 0.9, this.direction);
      const launch = randRange(0.8, 2.2);
      s.x = point.x;
      s.y = point.y;
      s.z = point.z;
      s.vx = dir.x * launch;
      s.vy = dir.y * launch + 0.5;
      s.vz = dir.z * launch;
      s.life = randRange(1.1, 1.9);
      s.size = randRange(0.045, 0.08);
      s.sizeEnd = s.size;
      s.rotation = randRange(0, Math.PI * 2);
      s.spin = randRange(-7, 7);
      const tone = randRange(0.7, 1.2);
      s.r = light.r * tone;
      s.g = light.g * tone;
      s.b = light.b * tone;
      s.a = 1;
      s.sprite = SPRITE.leaf;
      s.gravity = 2.6;
      s.drag = 2.6;
      s.stretch = 0;
      this.lit.emit();
    }
  }

  /** Water: a short column, thrown droplets and two rings spreading on the surface. */
  splash(point: THREE.Vector3, normal: THREE.Vector3, amount: number): void {
    const s = this.lit.spawn;
    const light = this.dustLight;
    for (let i = this.count(3, amount); i > 0; i--) {
      const rise = randRange(2.2, 3.6);
      s.x = point.x + normal.x * 0.1;
      s.y = point.y + normal.y * 0.1;
      s.z = point.z + normal.z * 0.1;
      s.vx = normal.x * rise + randRange(-0.3, 0.3);
      s.vy = normal.y * rise;
      s.vz = normal.z * rise + randRange(-0.3, 0.3);
      s.life = randRange(0.4, 0.6);
      s.size = randRange(0.2, 0.3);
      s.sizeEnd = s.size * 2.8;
      s.rotation = randRange(-0.25, 0.25);
      s.spin = 0;
      s.r = light.r;
      s.g = light.g;
      s.b = light.b;
      s.a = 0.9;
      s.sprite = SPRITE.splash;
      s.gravity = 6;
      s.drag = 1.2;
      s.stretch = 0;
      this.lit.emit();
    }
    const droplets = this.debrisLight;
    for (let i = this.count(8, amount); i > 0; i--) {
      const dir = randomInCone(normal, 0.5, this.direction);
      const launch = randRange(2, 4.8);
      s.x = point.x;
      s.y = point.y;
      s.z = point.z;
      s.vx = dir.x * launch;
      s.vy = dir.y * launch;
      s.vz = dir.z * launch;
      s.life = randRange(0.45, 0.8);
      s.size = randRange(0.02, 0.035);
      s.sizeEnd = s.size;
      s.rotation = 0;
      s.spin = 0;
      s.r = droplets.r;
      s.g = droplets.g;
      s.b = droplets.b;
      s.a = 0.85;
      s.sprite = SPRITE.streak;
      s.gravity = GRAVITY;
      s.drag = 0.5;
      s.stretch = 0.018;
      this.lit.emit();
    }
    this.rings.add(point, normal, 0.12, 1.1, 0.9, 0.55, 0);
    this.rings.add(point, normal, 0.1, 0.75, 0.9, 0.4, 0.16);
  }
}
