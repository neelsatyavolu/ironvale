import { Vector3 } from 'three/webgpu';
import type { GameContext, GrenadeHandState } from '../game/contracts';
import { GrenadeHand, type GrenadeHandInput } from './grenade-hand';
import { GRENADE, throwVelocity } from './grenade-math';

/** Where the throwing hand is, in camera space: right, down and forward of the eye. */
const HAND_OFFSET = new Vector3(0.2, -0.16, -0.3);
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * The local player's grenade: hold to aim, release to throw. Works out where
 * a throw would start and how fast from the camera, which is what the preview
 * arc draws and what the thrown grenade is given.
 */
export class GrenadeThrow implements GrenadeHandState {
  readonly origin = new Vector3();
  readonly velocity = new Vector3();
  private readonly hand = new GrenadeHand();
  private readonly input: Mutable<GrenadeHandInput> = { held: false, cancel: false, allowed: false };
  private readonly eye = new Vector3();
  private readonly forward = new Vector3();
  private readonly reach = new Vector3();

  constructor(private readonly ctx: GameContext) {}

  get count(): number {
    return this.hand.count;
  }

  get aiming(): boolean {
    return this.hand.aiming;
  }

  /** 0 with the gun up, 1 with it lowered out of the way of the throwing arm. */
  get lowered(): number {
    return this.hand.lowered;
  }

  restock(): void {
    this.hand.restock();
  }

  /** Put the grenade away unused (death, respawn). */
  cancel(): void {
    this.hand.cancel();
  }

  /** `cancel` puts it away unused this frame; `allowed` is false while the hands are busy. */
  update(dt: number, held: boolean, cancel: boolean, allowed: boolean): void {
    const input = this.input;
    input.held = held;
    input.cancel = cancel;
    input.allowed = allowed;
    const thrown = this.hand.update(dt, input);
    if (!thrown && !this.hand.aiming) return;
    this.line();
    if (thrown) this.ctx.grenades.launch(this.ctx.player, this.origin, this.velocity, true);
  }

  /** Work out the throw from where the camera is looking now. */
  private line(): void {
    const { ctx, eye, origin, reach } = this;
    const camera = ctx.engine.camera;
    camera.getWorldPosition(eye);
    camera.getWorldDirection(this.forward);
    throwVelocity(this.forward, this.velocity);
    reach.copy(HAND_OFFSET).applyQuaternion(camera.quaternion);
    const length = reach.length();
    // Standing against a wall, the hand would be inside it: throw from the eye instead.
    const blocked = ctx.world.raycast(eye, reach.divideScalar(length), length + GRENADE.radius * 2) !== null;
    origin.copy(eye);
    if (!blocked) origin.addScaledVector(reach, length);
  }
}
