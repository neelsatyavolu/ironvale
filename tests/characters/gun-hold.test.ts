import { Quaternion, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { CARBINE, GunHold, SIGHT, type HoldInput } from '../../src/characters/gun-hold';

const shoulder = new Vector3(0.17, 1.45, 0.05);
const input = (over: Partial<HoldInput> = {}): HoldInput => ({ aim: 1, carry: 0, pitch: 0, recoil: 0, recoilSide: 0, reload: -1, swayPitch: 0, swayYaw: 0, ...over });
const held = (over: Partial<HoldInput> = {}) => {
  const hold = new GunHold();
  hold.update(shoulder, input(over));
  return hold;
};
const onGun = (hold: GunHold, point: Vector3) => point.clone().applyQuaternion(hold.quaternion).add(hold.position);
const barrel = (hold: GunHold) => new Vector3(0, 0, -1).applyQuaternion(hold.quaternion);

/** The eye's position in the rifle's own space. */
const eyeOnGun = (hold: GunHold, eye: Vector3) => eye.clone().sub(hold.position).applyQuaternion(hold.quaternion.clone().invert());

describe('GunHold sight picture', () => {
  it('brings the sights up to an eye that is a little above them', () => {
    const plain = held();
    // An eye 3 cm above and 2 cm left of where the sight line passes.
    const eye = onGun(plain, new Vector3(-0.02, SIGHT.height + 0.03, 0.12));
    const hold = new GunHold();
    hold.update(shoulder, input(), eye);
    const local = eyeOnGun(hold, eye);
    expect(local.y).toBeCloseTo(SIGHT.height, 4);
    expect(local.x).toBeCloseTo(0, 4);
    // The rifle slid, it did not turn: the aim is untouched.
    expect(barrel(hold).distanceTo(barrel(plain))).toBeLessThan(1e-9);
  });

  it('moves the rifle no further than the shoulder allows', () => {
    const plain = held();
    const eye = onGun(plain, new Vector3(0.2, SIGHT.height + 0.3, 0.12));
    const hold = new GunHold();
    hold.update(shoulder, input(), eye);
    expect(hold.position.distanceTo(plain.position)).toBeLessThanOrEqual(Math.hypot(SIGHT.maxRaise, SIGHT.maxShift) + 1e-9);
    expect(eyeOnGun(hold, eye).y).toBeGreaterThan(SIGHT.height);
  });

  it('leaves the rifle alone at the ready and when carried', () => {
    for (const over of [{ aim: 0 }, { aim: 1, carry: 1 }]) {
      const plain = held(over);
      const eye = onGun(plain, new Vector3(0.02, SIGHT.height + 0.03, 0.12));
      const hold = new GunHold();
      hold.update(shoulder, input(over), eye);
      expect(hold.position.distanceTo(plain.position)).toBeLessThan(1e-9);
    }
  });

  it('keeps both hands on the rifle after it has moved', () => {
    const plain = held();
    const eye = onGun(plain, new Vector3(0, SIGHT.height + 0.03, 0.12));
    const hold = new GunHold();
    hold.update(shoulder, input(), eye);
    expect(hold.triggerPosition.distanceTo(onGun(hold, CARBINE.trigger.position))).toBeLessThan(1e-9);
    expect(hold.supportPosition.distanceTo(onGun(hold, CARBINE.support.position))).toBeLessThan(1e-9);
  });
});

describe('GunHold', () => {
  it('points the barrel exactly along the aim when shouldered', () => {
    for (const pitch of [-0.6, 0, 0.3, 0.9]) {
      const direction = barrel(held({ pitch }));
      expect(direction.x).toBeCloseTo(0, 6);
      expect(direction.y).toBeCloseTo(Math.sin(pitch), 6);
      expect(direction.z).toBeCloseTo(-Math.cos(pitch), 6);
    }
  });

  it('keeps the butt in the shoulder whatever the pitch', () => {
    const level = onGun(held(), CARBINE.butt);
    const up = onGun(held({ pitch: 0.8 }), CARBINE.butt);
    expect(level.distanceTo(up)).toBeLessThan(1e-6);
    expect(level.distanceTo(shoulder)).toBeLessThan(0.2);
  });

  it('puts the muzzle ahead of the shooter and near eye height when aiming level', () => {
    const muzzle = onGun(held(), CARBINE.muzzle);
    expect(muzzle.z).toBeLessThan(shoulder.z - 0.7);
    expect(muzzle.y).toBeGreaterThan(shoulder.y - 0.05);
    expect(muzzle.y).toBeLessThan(shoulder.y + 0.15);
  });

  it('lowers the muzzle at the ready and lifts it across the chest when carried', () => {
    expect(barrel(held({ aim: 0 })).y).toBeLessThan(-0.3);
    const carried = barrel(held({ aim: 0, carry: 1 }));
    expect(carried.y).toBeGreaterThan(0.3);
    expect(carried.x).toBeLessThan(-0.3);
  });

  it('keeps both grips on the gun', () => {
    for (const over of [{}, { aim: 0 }, { aim: 0, carry: 1 }, { pitch: 0.7, recoil: 1 }]) {
      const hold = held(over);
      expect(hold.triggerPosition.distanceTo(onGun(hold, CARBINE.trigger.position))).toBeLessThan(1e-6);
      expect(hold.supportPosition.distanceTo(onGun(hold, CARBINE.support.position))).toBeLessThan(1e-6);
    }
  });

  it('shoves the gun straight back along the barrel under recoil', () => {
    const rest = held();
    const kicked = held({ recoil: 1 });
    const moved = kicked.position.clone().sub(rest.position);
    expect(moved.z).toBeGreaterThan(0.015);
    expect(Math.abs(moved.x)).toBeLessThan(0.01);
    expect(barrel(kicked).y).toBeGreaterThan(0);
  });

  it('moves the support hand to the magazine and back during a reload', () => {
    const start = held({ aim: 0, reload: 0 });
    const middle = held({ aim: 0, reload: 0.5 });
    const end = held({ aim: 0, reload: 1 });
    const local = (hold: GunHold) => hold.supportPosition.clone().sub(hold.position).applyQuaternion(new Quaternion().copy(hold.quaternion).invert());
    expect(local(start).distanceTo(CARBINE.support.position)).toBeLessThan(1e-6);
    expect(local(end).distanceTo(CARBINE.support.position)).toBeLessThan(1e-6);
    expect(local(middle).y).toBeLessThan(CARBINE.magazine.position.y);
    expect(middle.triggerPosition.distanceTo(onGun(middle, CARBINE.trigger.position))).toBeLessThan(1e-6);
  });
});
