import * as THREE from 'three/webgpu';
import type { GameEvents } from '../game/contracts';
import type { ParticlePool } from './particles';
import { scaledCount } from './pool';
import { randomInCone, randRange, type FxEnv, type FxModule } from './shared';
import { SPRITE } from './textures';

const MIST: readonly [number, number, number] = [0.15, 0.012, 0.01];
const DROPS: readonly [number, number, number] = [0.11, 0.008, 0.006];
const MAX_DISTANCE = 90;

/** A brief dark mist and a few drops where a bullet hits someone. Kept small. */
export class Blood implements FxModule {
  private readonly unsubscribe: () => void;
  private readonly direction = new THREE.Vector3();
  private readonly scatter = new THREE.Vector3();
  private readonly mistLight = new THREE.Color();
  private readonly dropLight = new THREE.Color();

  constructor(
    private readonly env: FxEnv,
    private readonly lit: ParticlePool,
  ) {
    this.unsubscribe = env.ctx.events.on('combatantHit', this.onHit);
  }

  update(): void {}

  clear(): void {}

  dispose(): void {
    this.unsubscribe();
  }

  private readonly onHit = (event: GameEvents['combatantHit']): void => {
    if (!this.env.live) return;
    const ctx = this.env.ctx;
    // Nothing is drawn for hits on the player: it would only fill the screen.
    if (event.targetId === ctx.player.id) return;
    const point = event.hit.point;
    if (this.env.camera.position.distanceTo(point) > MAX_DISTANCE) return;

    const direction = this.direction.copy(event.direction);
    if (direction.lengthSq() < 1e-6) direction.set(0, 0, -1);
    direction.normalize();

    const density = this.env.particleDensity;
    const sun = this.env.sunAt(point, null);
    const mist = this.env.shade(MIST[0], MIST[1], MIST[2], sun, this.mistLight);
    const drops = this.env.shade(DROPS[0], DROPS[1], DROPS[2], sun, this.dropLight);
    const s = this.lit.spawn;

    for (let i = scaledCount(3, density, Math.random()); i > 0; i--) {
      // Most of the mist carries on with the bullet; one puff comes back toward the shooter.
      const forward = i > 1 ? 1 : -0.45;
      const dir = randomInCone(direction, 0.35, this.scatter);
      const speed = randRange(1.2, 3) * forward;
      s.x = point.x;
      s.y = point.y;
      s.z = point.z;
      s.vx = dir.x * speed;
      s.vy = dir.y * speed;
      s.vz = dir.z * speed;
      s.life = randRange(0.3, 0.5);
      s.size = randRange(0.05, 0.08);
      s.sizeEnd = randRange(0.22, 0.34);
      s.rotation = randRange(0, Math.PI * 2);
      s.spin = randRange(-1, 1);
      s.r = mist.r;
      s.g = mist.g;
      s.b = mist.b;
      s.a = randRange(0.5, 0.7);
      s.sprite = SPRITE.puffB;
      s.gravity = 1.5;
      s.drag = 5;
      s.stretch = 0;
      this.lit.emit();
    }

    for (let i = scaledCount(event.fatal ? 5 : 3, density, Math.random()); i > 0; i--) {
      const dir = randomInCone(direction, 0.5, this.scatter);
      const speed = randRange(1.5, 4);
      s.x = point.x;
      s.y = point.y;
      s.z = point.z;
      s.vx = dir.x * speed;
      s.vy = dir.y * speed + 0.8;
      s.vz = dir.z * speed;
      s.life = randRange(0.4, 0.7);
      s.size = randRange(0.012, 0.022);
      s.sizeEnd = s.size;
      s.rotation = 0;
      s.spin = 0;
      s.r = drops.r;
      s.g = drops.g;
      s.b = drops.b;
      s.a = 0.9;
      s.sprite = SPRITE.streak;
      s.gravity = 9.81;
      s.drag = 0.6;
      s.stretch = 0.02;
      this.lit.emit();
    }
  };
}
