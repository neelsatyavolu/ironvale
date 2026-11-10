import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { WEAPON_DEFS } from '../../src/weapons/defs';
import { WeaponMachine, type MachineSink, type TriggerInput } from '../../src/weapons/machine';
import { WEAPON_IDS, type WeaponId } from '../../src/weapons/models/api';
import { buildFallbackGun } from '../../src/weapons/view/fallback';
import { GunView } from '../../src/weapons/view/gun-view';
import { ramp, smoothstep, Spring } from '../../src/weapons/view/motion';
import { ViewRig, type ViewFrame } from '../../src/weapons/view/rig';
import type { RayHit, World } from '../../src/world/types';

const DT = 1 / 120;
const IDLE: TriggerInput = { fireHeld: false, firePressed: false, reloadPressed: false, ready: true };
const SINK: MachineSink = {
  fire: () => undefined,
  dryFire: () => undefined,
  stage: () => undefined,
  eject: () => undefined,
  clipEject: () => undefined,
};

function setup(id: WeaponId) {
  const camera = new THREE.PerspectiveCamera(78, 16 / 9, 0.04, 900);
  camera.position.set(3, 1.6, -2);
  camera.rotation.set(0.1, 0.7, 0, 'YXZ');
  const machine = new WeaponMachine(WEAPON_DEFS[id]);
  const view = new GunView(buildFallbackGun(id), WEAPON_DEFS[id]);
  const rig = new ViewRig(camera, null);
  rig.show(view);
  const frame: ViewFrame = {
    dt: DT,
    machine,
    aim: 0,
    sprint: 0,
    lowered: 0,
    speed: 0,
    verticalSpeed: 0,
    onGround: true,
    lookYaw: 0,
    lookPitch: 0,
    hidden: false,
  };
  const run = (seconds: number, world: World | null = null) => {
    for (let i = 0; i < Math.round(seconds / DT); i++) rig.update(frame, world);
  };
  /** A model point in camera space, with the view-model depth squeeze removed. */
  const inCamera = (object: THREE.Object3D) => {
    const point = camera.worldToLocal(object.getWorldPosition(new THREE.Vector3()));
    point.z /= rig.root.scale.z;
    return point;
  };
  return { camera, machine, view, rig, frame, run, inCamera };
}

describe('motion helpers', () => {
  it('eases and clamps', () => {
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 6);
    expect(smoothstep(2)).toBe(1);
    expect(ramp(1, 2, 0.5)).toBe(0);
    expect(ramp(1, 2, 1.5)).toBeCloseTo(0.5, 6);
    expect(ramp(1, 2, 3)).toBe(1);
  });

  it('springs settle back to rest after a kick, however long the frame', () => {
    for (const dt of [1 / 240, 1 / 60, 1 / 20]) {
      const spring = new Spring(260, 20);
      spring.kick(1);
      let peak = 0;
      for (let t = 0; t < 1.5; t += dt) peak = Math.max(peak, Math.abs(spring.step(dt)));
      expect(peak).toBeGreaterThan(0.02);
      expect(peak).toBeLessThan(0.08);
      expect(Math.abs(spring.value)).toBeLessThan(1e-3);
    }
  });
});

describe('stand-in guns', () => {
  it.each(WEAPON_IDS)('%s has every anchor, pointing the right way', (id) => {
    const model = buildFallbackGun(id);
    model.root.updateMatrixWorld(true);
    const at = (object: THREE.Object3D) => object.getWorldPosition(new THREE.Vector3());
    const muzzle = at(model.muzzle);
    const sight = at(model.sight);
    // Barrel along -Z, eye point behind and above the grip, muzzle ahead of everything.
    expect(muzzle.z).toBeLessThan(-0.1);
    expect(sight.z).toBeGreaterThan(muzzle.z + 0.15);
    expect(sight.y).toBeGreaterThan(0.03);
    expect(Math.abs(sight.x)).toBeLessThan(1e-6);
    expect(at(model.ejection).x).toBeGreaterThan(0);
    expect(at(model.grips.support).z).toBeLessThanOrEqual(at(model.grips.trigger).z);
    expect(model.cycleTravel).toBeGreaterThan(0.02);
    let meshes = 0;
    model.root.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        meshes++;
        expect(child.castShadow).toBe(true);
      }
    });
    expect(meshes).toBeGreaterThan(8);
  });

  it('gives each gun the parts its action needs', () => {
    expect(buildFallbackGun('m1911').parts.slide).toBeDefined();
    expect(buildFallbackGun('m1911').parts.magazine).toBeDefined();
    expect(buildFallbackGun('r870').parts.pump).toBeDefined();
    expect(buildFallbackGun('m24').parts.bolt).toBeDefined();
    expect(buildFallbackGun('m249').parts.cover).toBeDefined();
    expect(buildFallbackGun('m4a1').parts.magazine).toBeDefined();
  });
});

describe('aimed pose', () => {
  it.each(WEAPON_IDS)('%s puts the sight anchor on the camera, looking down its axis', (id) => {
    const { view, frame, run, inCamera, camera } = setup(id);
    frame.aim = 1;
    run(1.5);
    const sight = inCamera(view.model.sight);
    expect(sight.length()).toBeLessThan(1e-4);
    const sightForward = view.model.sight.getWorldDirection(new THREE.Vector3());
    const cameraForward = camera.getWorldDirection(new THREE.Vector3());
    // Object3D.getWorldDirection reports +Z; the sight looks down its -Z like a camera does.
    expect(sightForward.negate().angleTo(cameraForward)).toBeLessThan(2e-3);
  });

  it('keeps the sight on the axis while the gun recoils', () => {
    const { view, rig, frame, run, inCamera } = setup('m4a1');
    frame.aim = 1;
    run(1);
    rig.fired(1, 0.7);
    let back = 0;
    for (let i = 0; i < 40; i++) {
      rig.update(frame, null);
      const sight = inCamera(view.model.sight);
      expect(Math.hypot(sight.x, sight.y)).toBeLessThan(1e-4);
      back = Math.max(back, sight.z);
    }
    expect(back).toBeGreaterThan(0.004);
  });

  it('sits low and to the right at the hip', () => {
    const { view, run, inCamera } = setup('m4a1');
    run(0.5);
    const grip = inCamera(view.model.grips.trigger);
    expect(grip.x).toBeGreaterThan(0.05);
    expect(grip.y).toBeLessThan(-0.05);
    expect(grip.z).toBeLessThan(-0.1);
  });
});

describe('procedural motion', () => {
  it('lowers the gun for a switch and for the sprint carry', () => {
    const still = setup('m4a1');
    still.run(0.5);
    const rest = still.inCamera(still.view.model.muzzle);

    const lowered = setup('m4a1');
    lowered.frame.lowered = 1;
    lowered.run(0.5);
    expect(lowered.inCamera(lowered.view.model.muzzle).y).toBeLessThan(rest.y - 0.2);

    const sprint = setup('m4a1');
    sprint.frame.sprint = 1;
    sprint.run(0.5);
    expect(sprint.inCamera(sprint.view.model.muzzle).x).toBeLessThan(rest.x - 0.1);
  });

  it('bobs with ground speed and stays still at rest', () => {
    const { view, frame, run, inCamera, rig } = setup('m4a1');
    run(1);
    const spread = (seconds: number) => {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < Math.round(seconds / DT); i++) {
        rig.update(frame, null);
        const x = inCamera(view.model.grips.trigger).x;
        min = Math.min(min, x);
        max = Math.max(max, x);
      }
      return max - min;
    };
    const idle = spread(1);
    frame.speed = 4.2;
    const walking = spread(1.5);
    expect(idle).toBeLessThan(0.001);
    expect(walking).toBeGreaterThan(0.004);
  });

  it('lags behind a turn and recovers', () => {
    const { view, frame, run, inCamera } = setup('m4a1');
    run(0.5);
    const rest = inCamera(view.model.muzzle).x;
    frame.lookYaw = 2 * DT; // turning left at 2 rad/s
    run(0.4);
    expect(inCamera(view.model.muzzle).x).toBeGreaterThan(rest + 0.005);
    frame.lookYaw = 0;
    run(1);
    expect(inCamera(view.model.muzzle).x).toBeCloseTo(rest, 3);
  });

  it('swings the barrel away from a wall closer than the muzzle', () => {
    const wall = (distance: number): World =>
      ({
        raycast: (origin: THREE.Vector3, direction: THREE.Vector3, max: number): RayHit | null =>
          distance <= max
            ? {
                distance,
                point: origin.clone().addScaledVector(direction, distance),
                normal: direction.clone().negate(),
                surface: 'concrete',
              }
            : null,
      }) as unknown as World;
    const { view, run, camera } = setup('m4a1');
    const muzzleDepth = () => -camera.worldToLocal(view.model.muzzle.getWorldPosition(new THREE.Vector3())).z;
    run(0.5);
    const free = muzzleDepth();
    expect(free).toBeGreaterThan(0.45);
    run(1, wall(5));
    expect(muzzleDepth()).toBeCloseTo(free, 3);
    for (const distance of [0.5, 0.36]) {
      run(1, wall(distance));
      expect(muzzleDepth()).toBeLessThan(distance);
    }
    run(1, wall(5));
    expect(muzzleDepth()).toBeCloseTo(free, 2);
  });
});

describe('parts in time with the action', () => {
  function act(id: WeaponId) {
    const context = setup(id);
    const step = (input: TriggerInput) => {
      context.machine.step(DT, input, SINK);
      context.rig.update(context.frame, null);
    };
    const run = (seconds: number, input: TriggerInput = IDLE) => {
      for (let i = 0; i < Math.round(seconds / DT); i++) step(input);
    };
    return { ...context, step, run };
  }
  const PRESS: TriggerInput = { ...IDLE, fireHeld: true, firePressed: true };
  const RELOAD: TriggerInput = { ...IDLE, reloadPressed: true };

  it('drops the magazine, hides it, and seats it again by the magIn mark', () => {
    const { machine, view, step, run } = act('m4a1');
    const magazine = view.model.parts.magazine!;
    const rest = magazine.position.y;
    machine.setAmmo(10, 90);
    step(RELOAD);
    run(0.8);
    expect(magazine.visible).toBe(false);
    expect(view.parts.supportAway).toBeGreaterThan(0.9);
    while (machine.magazine === 10) run(DT);
    run(0.02);
    expect(magazine.visible).toBe(true);
    expect(magazine.position.y).toBeCloseTo(rest, 3);
    run(1);
    expect(view.parts.supportAway).toBeLessThan(0.02);
    expect(view.parts.tilt).toBeLessThan(0.02);
  });

  it('snaps the slide back with a shot and locks it open on the last round', () => {
    const { machine, view, rig, step, run } = act('m1911');
    const slide = view.model.parts.slide!;
    const rest = slide.position.z;
    step(PRESS);
    rig.fired(0, 0);
    run(0.02);
    expect(slide.position.z).toBeGreaterThan(rest + view.model.cycleTravel * 0.5);
    run(0.3);
    expect(slide.position.z).toBeCloseTo(rest, 4);
    machine.setAmmo(1, 14);
    step(PRESS);
    rig.fired(0, 0);
    run(0.5);
    expect(slide.position.z).toBeCloseTo(rest + view.model.cycleTravel, 3);
    step(RELOAD);
    run(3);
    expect(machine.magazine).toBe(7);
    expect(slide.position.z).toBeCloseTo(rest, 4);
  });

  it('strokes the pump back and forward between the two marks', () => {
    const { machine, view, step, run } = act('r870');
    const pump = view.model.parts.pump!;
    const rest = pump.position.z;
    step(PRESS);
    const action = machine.action!;
    const back = action.marks.find((mark) => mark.stage === 'pumpBack')!.time;
    const forward = action.marks.find((mark) => mark.stage === 'pumpForward')!.time;
    run(back);
    expect(pump.position.z).toBeCloseTo(rest + view.model.cycleTravel, 2);
    run(forward - back + 0.02);
    expect(pump.position.z).toBeCloseTo(rest, 2);
  });

  it('lifts and draws the bolt, and moves the firing hand to it', () => {
    const { machine, view, step, run } = act('m24');
    const bolt = view.model.parts.bolt!;
    const rest = bolt.position.z;
    step(PRESS);
    const back = machine.action!.marks.find((mark) => mark.stage === 'boltBack')!.time;
    run(back);
    expect(bolt.position.z).toBeCloseTo(rest + view.model.cycleTravel, 2);
    expect(view.parts.triggerAway).toBeGreaterThan(0.8);
    run(1.5);
    expect(bolt.position.z).toBeCloseTo(rest, 3);
    expect(view.parts.triggerAway).toBeLessThan(0.02);
  });

  it('opens the feed cover for a belt change', () => {
    const { machine, view, step, run } = act('m249');
    const cover = view.model.parts.cover!;
    machine.setAmmo(20, 200);
    step(RELOAD);
    run(2);
    expect(cover.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.8);
    run(4);
    expect(cover.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(0.01);
  });
});
