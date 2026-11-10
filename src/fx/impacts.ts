import * as THREE from 'three/webgpu';
import type { GameEvents } from '../game/contracts';
import type { Decals } from './decals';
import { ImpactEmitters } from './impact-emitters';
import type { ParticlePool } from './particles';
import type { Rings } from './rings';
import type { FxEnv, FxModule } from './shared';
import { SURFACE_LOOKS } from './surfaces';
import { SPRITE } from './textures';

/** Share of the particles drawn, by distance from the camera in metres. Past the last step only the hole is left. */
const LOD_STEPS: readonly (readonly [number, number])[] = [
  [35, 1],
  [70, 0.55],
  [140, 0.25],
];
const PELLET_SCALE = 0.45;
const WET_DUST = 0.55;
const UP = new THREE.Vector3(0, 1, 0);

/** Dust, chips, sparks and splashes where bullets land, chosen by the surface that was hit. */
export class Impacts implements FxModule {
  private readonly unsubscribe: () => void;
  private readonly emit: ImpactEmitters;
  private readonly axis = new THREE.Vector3();

  constructor(
    private readonly env: FxEnv,
    lit: ParticlePool,
    glow: ParticlePool,
    rings: Rings,
    private readonly decals: Decals,
  ) {
    this.emit = new ImpactEmitters(env, lit, glow, rings);
    this.unsubscribe = env.ctx.events.on('bulletImpact', this.onImpact);
  }

  update(): void {}

  clear(): void {}

  dispose(): void {
    this.unsubscribe();
  }

  private readonly onImpact = (event: GameEvents['bulletImpact']): void => {
    if (!this.env.live) return;
    const emit = this.emit;
    const { point, normal, surface } = event.hit;
    const look = SURFACE_LOOKS[surface];
    if (look.family === 'none') return;

    const distance = this.env.camera.position.distanceTo(point);
    let amount = 0;
    for (const [limit, scale] of LOD_STEPS) {
      if (distance < limit) {
        amount = scale;
        break;
      }
    }
    const pellets = event.weapon.pellets > 1;
    if (look.decal) this.decals.add(look.decal, point, normal, pellets ? 0.6 : 1);
    if (amount === 0) return;
    amount *= this.env.particleDensity * (pellets ? PELLET_SCALE : 1);
    // Wet ground and walls give off less dust.
    const dustiness = look.dustiness * (this.env.weather === 'rain' ? WET_DUST : 1);

    const sun = this.env.sunAt(point, normal);
    this.env.shade(look.dust[0], look.dust[1], look.dust[2], sun, emit.dustLight);
    this.env.shade(look.debris[0], look.debris[1], look.debris[2], sun, emit.debrisLight);

    switch (look.family) {
      case 'masonry':
        emit.dust(point, normal, amount * dustiness, 6, 2.8, 0.95, 2.3, 0.6);
        emit.burst(point, normal, amount, 3, 5.5, 0.5, 0.5, 0.8);
        emit.debris(point, normal, amount, 7, 4.5, 0.05, SPRITE.chipA);
        emit.grit(point, normal, amount, 2, 3.2);
        break;
      case 'metal':
        emit.sparks(point, normal, amount, 12, sun);
        emit.flare(point, normal, 0.17);
        emit.dust(point, normal, amount * dustiness, 4, 1.8, 0.5, 1.1, 0.4);
        break;
      case 'wood':
        emit.debris(point, normal, amount, 7, 4, 0.11, SPRITE.splinter);
        emit.debris(point, normal, amount, 3, 3, 0.03, SPRITE.chipB);
        emit.dust(point, normal, amount * dustiness, 5, 2.2, 0.75, 1.8, 0.5);
        break;
      case 'soil':
        // Earth is thrown up more than out, whatever the slope.
        this.axis.copy(normal).lerp(UP, 0.45).normalize();
        emit.burst(point, this.axis, amount, 5, 4.2, 0.8, 0.95, 0.85);
        emit.grit(point, this.axis, amount, 7, 4.8);
        emit.dust(point, this.axis, amount * dustiness, 3, 1.6, 1, 2.4, 0.42);
        if (surface === 'grass') emit.leaves(point, this.axis, amount, 3);
        break;
      case 'water':
        emit.splash(point, normal, amount);
        break;
      case 'glass':
        emit.shards(point, normal, amount, 10, sun);
        emit.dust(point, normal, amount * dustiness, 2, 1.6, 0.4, 0.7, 0.2);
        break;
      case 'foliage':
        emit.leaves(point, normal, amount, 6);
        emit.dust(point, normal, amount * dustiness, 2, 0.9, 0.4, 0.8, 0.3);
        break;
    }
  };
}
