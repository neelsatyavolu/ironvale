import type { Vector3 } from 'three/webgpu';
import type { GameContext, WeaponDef } from '../game/contracts';
import { BreathSway } from './aim';
import { AimAssist, type AssistFrame } from './assist';
import { ViewKickMirror } from './recoil';
import { smoothstep } from './view/motion';

/** A view change larger than this in one frame is a teleport, not the player's hand. */
const MAX_LOOK_STEP = 0.5;
const TWO_PI = Math.PI * 2;
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * The small turns the weapons add to the player's view: scope sway and aim
 * assist. Also works out how much of each frame's view change was the player's
 * own hand, by subtracting those turns and the recoil kick.
 */
export class ViewSteering {
  /** The player's own turn this frame, radians. */
  lookYaw = 0;
  lookPitch = 0;
  readonly breath = new BreathSway();
  readonly assist = new AimAssist();

  private readonly kick = new ViewKickMirror();
  private readonly frame: Mutable<AssistFrame>;
  private previousYaw = 0;
  private previousPitch = 0;
  private hasPrevious = false;
  private lastNudgeYaw = 0;
  private lastNudgePitch = 0;

  constructor(
    private readonly ctx: GameContext,
    eye: Vector3,
  ) {
    this.frame = {
      dt: 0,
      strength: 0,
      yaw: 0,
      pitch: 0,
      inputYaw: 0,
      inputPitch: 0,
      zoom: 1,
      aimStarted: false,
      aimTime: 0.2,
      eye,
      targets: [],
      visible: (from, to) => this.ctx.world.lineOfSight(from, to),
    };
  }

  /** Tell the mirror about a kick handed to `PlayerBody.addRecoil`. */
  kicked(pitchDegrees: number, yawDegrees: number, recovery: number): void {
    this.kick.add(pitchDegrees, yawDegrees, recovery);
  }

  /** Call first each frame, after the body has moved the view. */
  measure(dt: number): void {
    const player = this.ctx.player;
    this.kick.step(dt);
    this.lookYaw = 0;
    this.lookPitch = 0;
    if (this.hasPrevious) {
      const turned = player.yaw - this.previousYaw;
      const yaw = turned - Math.round(turned / TWO_PI) * TWO_PI - this.lastNudgeYaw - this.kick.deltaYaw;
      const pitch = player.pitch - this.previousPitch - this.lastNudgePitch - this.kick.deltaPitch;
      if (Math.abs(yaw) < MAX_LOOK_STEP && Math.abs(pitch) < MAX_LOOK_STEP) {
        this.lookYaw = yaw;
        this.lookPitch = pitch;
      }
    }
    this.previousYaw = player.yaw;
    this.previousPitch = player.pitch;
    this.hasPrevious = true;
    this.lastNudgeYaw = 0;
    this.lastNudgePitch = 0;
  }

  /**
   * Apply this frame's sway and assist.
   * @param active the player has control (pointer lock or scripted input)
   * @param aimStarted the sights started to come up this frame
   */
  steer(dt: number, def: WeaponDef, aimBlend: number, active: boolean, aimStarted: boolean, holdBreath: boolean): void {
    const { ctx } = this;
    const player = ctx.player;
    const unsteadiness = (player.crouching ? 0.6 : 1) * (1 + Math.min(1, player.speed / 3) * 1.2);
    this.breath.update(dt, def.scoped ? aimBlend : 0, holdBreath, unsteadiness);
    let yaw = this.breath.deltaYaw;
    let pitch = this.breath.deltaPitch;

    const strength = ctx.settings.value.controls.aimAssist;
    if (strength > 0 && active && ctx.map) {
      const frame = this.frame;
      frame.dt = dt;
      frame.strength = strength;
      frame.yaw = player.yaw;
      frame.pitch = player.pitch;
      frame.inputYaw = this.lookYaw;
      frame.inputPitch = this.lookPitch;
      frame.zoom = 1 + (def.aimZoom - 1) * smoothstep(aimBlend);
      frame.aimStarted = aimStarted;
      frame.aimTime = def.aimTime;
      player.eyePosition(frame.eye);
      frame.targets = ctx.combat.enemiesOf(player.team);
      this.assist.update(frame);
      yaw += this.assist.nudgeYaw;
      pitch += this.assist.nudgePitch;
    } else {
      this.assist.reset();
    }

    // The body only applies nudges while the player has control; do not let them pile up otherwise.
    if (!ctx.input.locked || (yaw === 0 && pitch === 0)) return;
    player.nudgeView(yaw, pitch);
    this.lastNudgeYaw = yaw;
    this.lastNudgePitch = pitch;
  }

  reset(): void {
    this.breath.reset();
    this.assist.reset();
    this.kick.reset();
    this.hasPrevious = false;
    this.lastNudgeYaw = this.lastNudgePitch = 0;
    this.lookYaw = this.lookPitch = 0;
  }
}
