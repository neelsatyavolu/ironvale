import * as THREE from 'three/webgpu';
import type { GameEvents } from '../game/contracts';
import { GRENADE, blastShake } from '../weapons/grenade-math';
import type { Decals } from './decals';
import { GrenadeArc } from './grenade-arc';
import { GrenadeBlast } from './grenade-blast';
import type { ParticlePool } from './particles';
import type { Rings } from './rings';
import type { FxEnv, FxModule } from './shared';

/** The shell is drawn a little larger than it collides, so it reads at range. */
const BODY_RADIUS = GRENADE.radius * 1.15;
const SHAKE_SECONDS = 0.5;
/** Peak view rotation, radians, and drop, metres, for a blast at the player's feet. */
const SHAKE_ANGLE = 0.04;
const SHAKE_DROP = 0.035;
const PARKED_Y = -400;
/** Grenades drawn at once; matches the flight pool. */
const BODY_COUNT = 4;

/**
 * Everything seen of a grenade: the preview arc while one is aimed, the body
 * in flight, the blast, and the jolt it gives the view.
 */
export class GrenadeFx implements FxModule {
  private readonly arc: GrenadeArc;
  private readonly blast: GrenadeBlast;
  private readonly bodies: THREE.Mesh[] = [];
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshStandardNodeMaterial;
  private readonly unsubscribe: () => void;
  /** true from map load until the first update: everything is in the scene so its shaders compile. */
  private parked = false;
  private shake = 0;
  private shakeStrength = 0;

  constructor(
    private readonly env: FxEnv,
    lit: ParticlePool,
    glow: ParticlePool,
    rings: Rings,
    decals: Decals,
  ) {
    this.arc = new GrenadeArc(env);
    this.blast = new GrenadeBlast(env, lit, glow, rings, decals);
    this.geometry = new THREE.SphereGeometry(BODY_RADIUS, 12, 8);
    this.geometry.scale(1, 1.3, 1);
    this.material = new THREE.MeshStandardNodeMaterial({ color: 0x343d27, roughness: 0.62, metalness: 0.35 });
    for (let i = 0; i < BODY_COUNT; i++) {
      const mesh = new THREE.Mesh(this.geometry, this.material);
      mesh.castShadow = true;
      mesh.visible = false;
      env.root.add(mesh);
      this.bodies.push(mesh);
    }
    this.arc.hide();
    this.unsubscribe = env.ctx.events.on('grenadeExploded', this.onExploded);
  }

  enterMap(): void {
    this.parked = true;
    this.arc.park();
    for (const mesh of this.bodies) {
      mesh.position.set(0, PARKED_Y, 0);
      mesh.visible = true;
    }
  }

  update(dt: number): void {
    if (this.parked) {
      this.parked = false;
      this.arc.hide();
    }
    const { env } = this;
    const hand = env.ctx.weapons.grenade;
    if (hand.aiming && env.ctx.player.alive) this.arc.show(hand.origin, hand.velocity);
    else this.arc.hide();

    const flights = env.ctx.grenades.flights;
    for (let i = 0; i < this.bodies.length; i++) {
      const mesh = this.bodies[i]!;
      const flight = flights[i];
      mesh.visible = flight !== undefined && flight.active;
      if (!flight || !flight.active) continue;
      mesh.position.copy(flight.drawPosition);
      if (!flight.resting) {
        // Tumble end over end at about the rate a rolling grenade would.
        mesh.rotation.x += (flight.velocity.length() / BODY_RADIUS) * dt * 0.35;
        mesh.rotation.z += dt * 3;
      }
    }

    if (this.shake > 0) this.applyShake(dt);
  }

  clear(): void {
    this.shake = 0;
    this.parked = false;
    this.arc.hide();
    for (const mesh of this.bodies) mesh.visible = false;
  }

  dispose(): void {
    this.unsubscribe();
    this.arc.dispose();
    for (const mesh of this.bodies) this.env.root.remove(mesh);
    this.geometry.dispose();
    this.material.dispose();
  }

  private readonly onExploded = (event: GameEvents['grenadeExploded']): void => {
    if (!this.env.live) return;
    this.blast.emit(event.position);
    const strength = blastShake(this.env.camera.position.distanceTo(event.position));
    if (strength <= 0) return;
    this.shakeStrength = this.shake > 0 ? Math.max(strength, this.shakeStrength) : strength;
    this.shake = SHAKE_SECONDS;
  };

  /**
   * Jolt the view. The player's body sets the camera afresh every frame, so
   * this offset lasts one frame and never builds up.
   */
  private applyShake(dt: number): void {
    this.shake = Math.max(0, this.shake - dt);
    const fade = this.shake / SHAKE_SECONDS;
    // Players who turn view bob down get less of this too.
    const amount = this.shakeStrength * fade * fade * this.env.ctx.settings.value.gameplay.headBob;
    const camera = this.env.camera;
    const t = this.env.now;
    camera.rotation.x += Math.sin(t * 71) * SHAKE_ANGLE * amount;
    camera.rotation.y += Math.sin(t * 53 + 1.3) * SHAKE_ANGLE * 0.6 * amount;
    camera.rotation.z += Math.sin(t * 43 + 2.1) * SHAKE_ANGLE * 0.8 * amount;
    camera.position.y -= Math.abs(Math.sin(t * 37)) * SHAKE_DROP * amount;
    if (this.shake === 0) this.shakeStrength = 0;
  }
}
