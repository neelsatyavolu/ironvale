import * as THREE from 'three/webgpu';
import type { GameEvents } from '../game/contracts';
import type { ParticlePool } from './particles';
import { randRange, type FxEnv, type FxModule } from './shared';
import { SPRITE } from './textures';
import type { Tracers } from './tracers';

/** Length of the streak drawn past the player, centred on the closest point. */
const STREAK_PATH = 7;
const STREAK_SPEED = 130;
const STREAK_LENGTH = 2.6;
/** A trace counts as the source of a near miss when it passes this close to the reported point. */
const MATCH_DISTANCE = 1.5;

/** A fast streak and a thread of disturbed air where a bullet just missed the player. */
export class NearMiss implements FxModule {
  private readonly unsubscribe: (() => void)[];
  private readonly lastFrom = new THREE.Vector3();
  private readonly lastDirection = new THREE.Vector3();
  private lastLength = 0;
  private readonly direction = new THREE.Vector3();
  private readonly start = new THREE.Vector3();
  private readonly offset = new THREE.Vector3();
  private readonly light = new THREE.Color();

  constructor(
    private readonly env: FxEnv,
    private readonly tracers: Tracers,
    private readonly lit: ParticlePool,
  ) {
    this.unsubscribe = [env.ctx.events.on('bulletTrace', this.onTrace), env.ctx.events.on('nearMiss', this.onNearMiss)];
  }

  update(): void {}

  clear(): void {
    this.lastLength = 0;
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
  }

  /** The event carries only a point, so remember incoming fire to recover the bullet's heading. */
  private readonly onTrace = (event: GameEvents['bulletTrace']): void => {
    if (event.local) return;
    this.lastFrom.copy(event.from);
    this.lastDirection.subVectors(event.to, event.from);
    this.lastLength = this.lastDirection.length();
    if (this.lastLength > 1e-3) this.lastDirection.divideScalar(this.lastLength);
  };

  private readonly onNearMiss = (event: GameEvents['nearMiss']): void => {
    if (!this.env.live) return;
    const direction = this.direction;
    if (this.lastLength > 0 && this.distanceToLastTrace(event.point) < MATCH_DISTANCE) {
      direction.copy(this.lastDirection);
    } else {
      // No matching trace: assume the round crossed the view from the side.
      direction.subVectors(event.point, this.env.camera.position).cross(THREE.Object3D.DEFAULT_UP);
      if (direction.lengthSq() < 1e-6) direction.set(1, 0, 0);
      direction.normalize();
    }
    this.start.copy(event.point).addScaledVector(direction, -STREAK_PATH * 0.5);
    this.tracers.add(this.start, direction, STREAK_PATH, STREAK_SPEED, STREAK_LENGTH, 0.8);

    const light = this.env.shade(0.75, 0.75, 0.78, 1, this.light);
    const s = this.lit.spawn;
    for (let i = 0; i < 4; i++) {
      const along = randRange(-1.2, 1.2);
      s.x = event.point.x + direction.x * along;
      s.y = event.point.y + direction.y * along;
      s.z = event.point.z + direction.z * along;
      s.vx = direction.x * 5;
      s.vy = direction.y * 5;
      s.vz = direction.z * 5;
      s.life = randRange(0.3, 0.5);
      s.size = 0.07;
      s.sizeEnd = 0.32;
      s.rotation = randRange(0, Math.PI * 2);
      s.spin = 0;
      s.r = light.r;
      s.g = light.g;
      s.b = light.b;
      s.a = 0.26;
      s.sprite = SPRITE.wisp;
      s.gravity = 0;
      s.drag = 6;
      s.stretch = 0;
      this.lit.emit();
    }
  };

  private distanceToLastTrace(point: THREE.Vector3): number {
    const along = this.offset.subVectors(point, this.lastFrom).dot(this.lastDirection);
    const clamped = Math.min(this.lastLength, Math.max(0, along));
    return this.offset.copy(this.lastFrom).addScaledVector(this.lastDirection, clamped).distanceTo(point);
  }
}
