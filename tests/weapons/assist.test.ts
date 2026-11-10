import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { AimAssist, type AssistFrame, type AssistTarget } from '../../src/weapons/assist';

const DEG = Math.PI / 180;
const DT = 1 / 60;
const eye = new Vector3(0, 1.64, 0);

/** A standing enemy `distance` metres ahead and `offDegrees` to the right of straight ahead (yaw 0 looks down -Z). */
function enemy(distance: number, offDegrees: number, id = 1): AssistTarget {
  const angle = offDegrees * DEG;
  return {
    id,
    alive: true,
    crouching: false,
    position: new Vector3(Math.sin(angle) * distance, 0, -Math.cos(angle) * distance),
  };
}

function frame(overrides: Partial<AssistFrame>): AssistFrame {
  return {
    dt: DT,
    strength: 1,
    yaw: 0,
    pitch: -0.013,
    inputYaw: 0,
    inputPitch: 0,
    zoom: 1,
    aimStarted: false,
    aimTime: 0.24,
    eye,
    targets: [],
    visible: () => true,
    ...overrides,
  };
}

describe('AimAssist', () => {
  it('does nothing when switched off', () => {
    const assist = new AimAssist();
    assist.update(frame({ strength: 0, targets: [enemy(20, 1)], inputYaw: -0.01, aimStarted: true }));
    expect(assist.nudgeYaw).toBe(0);
    expect(assist.nudgePitch).toBe(0);
  });

  it('never moves the view while the player is not moving it', () => {
    const assist = new AimAssist();
    for (let i = 0; i < 30; i++) {
      assist.update(frame({ targets: [enemy(20, 1.5)] }));
      expect(assist.nudgeYaw).toBe(0);
      expect(assist.nudgePitch).toBe(0);
    }
  });

  it('slows a turn across a target without ever reversing it', () => {
    const assist = new AimAssist();
    // Turning left (positive yaw) with an enemy dead ahead.
    const input = 0.01;
    assist.update(frame({ targets: [enemy(20, 0)], inputYaw: input }));
    expect(assist.nudgeYaw).toBeLessThan(0);
    expect(Math.abs(assist.nudgeYaw)).toBeLessThan(input * 0.6);
    expect(assist.slowdown).toBeGreaterThan(0.2);
  });

  it('pulls toward the chest when the player turns toward the target', () => {
    const assist = new AimAssist();
    // Enemy 2 degrees to the right; turning right is negative yaw.
    const input = -0.004;
    assist.update(frame({ targets: [enemy(30, 2)], inputYaw: input }));
    const net = input + assist.nudgeYaw;
    expect(net).toBeLessThan(0);
    // The nudge is always smaller than the player's own turn, and no target means no nudge.
    const plain = new AimAssist();
    plain.update(frame({ targets: [], inputYaw: input }));
    expect(plain.nudgeYaw).toBe(0);
    expect(Math.abs(assist.nudgeYaw)).toBeLessThan(Math.abs(input));
  });

  it('does not pull back a player who is turning away', () => {
    const assist = new AimAssist();
    // Enemy to the right, player turning left: any nudge may only slow, never drag toward the target faster than the player moves.
    const input = 0.006;
    assist.update(frame({ targets: [enemy(30, 1.5)], inputYaw: input }));
    expect(input + assist.nudgeYaw).toBeGreaterThan(0);
    expect(assist.pull).toBe(0);
  });

  it('ignores targets outside the cone', () => {
    const assist = new AimAssist();
    assist.update(frame({ targets: [enemy(30, 9)], inputYaw: -0.01 }));
    expect(assist.nudgeYaw).toBe(0);
  });

  it('ignores targets behind cover and limits sight checks per frame', () => {
    const assist = new AimAssist();
    let checks = 0;
    const targets = [enemy(20, 0.5, 1), enemy(22, 1, 2), enemy(25, -1, 3), enemy(30, 1.5, 4), enemy(18, -2, 5)];
    assist.update(
      frame({
        targets,
        inputYaw: -0.01,
        visible: () => {
          checks++;
          return false;
        },
      }),
    );
    expect(assist.nudgeYaw).toBe(0);
    expect(checks).toBeGreaterThan(0);
    expect(checks).toBeLessThanOrEqual(2);
  });

  it('picks the visible target nearest the reticle', () => {
    const assist = new AimAssist();
    assist.update(frame({ targets: [enemy(20, 2.5, 1), enemy(40, -0.6, 2)], inputYaw: 0.002 }));
    expect(assist.targetId).toBe(2);
  });

  it('tightens the cone with zoom', () => {
    const assist = new AimAssist();
    assist.update(frame({ targets: [enemy(60, 2)], inputYaw: -0.004, zoom: 0.16 }));
    expect(assist.nudgeYaw).toBe(0);
  });

  it('eases onto a nearby target as the sights come up, without overshooting', () => {
    const assist = new AimAssist();
    const target = enemy(25, 3);
    let yaw = 0;
    const chestYaw = -3 * DEG;
    assist.update(frame({ targets: [target], aimStarted: true, yaw }));
    yaw += assist.nudgeYaw;
    for (let i = 0; i < 30; i++) {
      assist.update(frame({ targets: [target], yaw }));
      yaw += assist.nudgeYaw;
    }
    // Moved most of the way, in the right direction, and stopped short of the chest.
    expect(yaw).toBeLessThan(chestYaw * 0.4);
    expect(yaw).toBeGreaterThan(chestYaw);
    // And it stops once the sights are up.
    assist.update(frame({ targets: [target], yaw }));
    expect(assist.nudgeYaw).toBe(0);
  });

  it('scales the snap with the setting', () => {
    const turn = (strength: number) => {
      const assist = new AimAssist();
      const target = enemy(25, 3);
      let yaw = 0;
      assist.update(frame({ targets: [target], aimStarted: true, yaw, strength }));
      yaw += assist.nudgeYaw;
      for (let i = 0; i < 30; i++) {
        assist.update(frame({ targets: [target], yaw, strength }));
        yaw += assist.nudgeYaw;
      }
      return Math.abs(yaw);
    };
    expect(turn(0.3)).toBeLessThan(turn(1));
    expect(turn(0.3)).toBeGreaterThan(0);
  });

  it('abandons the snap when the player steers the other way', () => {
    const assist = new AimAssist();
    const target = enemy(25, 3);
    assist.update(frame({ targets: [target], aimStarted: true }));
    assist.update(frame({ targets: [target], inputYaw: 0.01 }));
    assist.update(frame({ targets: [target] }));
    expect(assist.nudgeYaw).toBe(0);
  });
});
