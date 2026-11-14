/**
 * Weapon fixtures from the real TypeScript modules: WeaponMachine traces for seeded trigger
 * scripts, stepGrenade trajectories in the grenade test world, and damage / blast curves.
 */
import { Vector3 } from 'three/webgpu';
import { hashString, seededRandom } from '../../../src/core/random';
import type { HitZone } from '../../../src/game/contracts';
import { WEAPON_DEFS } from '../../../src/weapons/defs';
import { blastDamage, createGrenadeBody, GRENADE, stepGrenade, throwVelocity } from '../../../src/weapons/grenade-math';
import { WeaponMachine, type MachineSink } from '../../../src/weapons/machine';
import { damageAt } from '../../../src/weapons/math';
import { WEAPON_IDS } from '../../../src/weapons/models/api';
import type { CollisionWorld } from '../../../src/world/collision';
import { SURFACES } from './worlds';

/**
 * One frame of a machine script: [dt, fireHeld, firePressed, reloadPressed, ready] plus an optional
 * command run before the step: ['setAmmo', rounds, reserve] or ['cancel'] or ['refill'].
 * Record after the step: [magazine, reserve, reloading, busy, cycling, chambered, actionTime] and
 * the sink calls made during it ('fire:1' = last round).
 */
export function machineTraces(): unknown[] {
  const traces: unknown[] = [];
  for (const id of WEAPON_IDS) {
    for (let variant = 0; variant < 3; variant++) {
      const random = seededRandom(hashString(`machine:${id}:${variant}`));
      const machine = new WeaponMachine(WEAPON_DEFS[id]);
      let calls: string[] = [];
      const sink: MachineSink = {
        fire: (last) => calls.push(`fire:${Number(last)}`),
        dryFire: () => calls.push('dry'),
        stage: (stage) => calls.push(`stage:${stage}`),
        eject: () => calls.push('eject'),
      };
      const frames: unknown[] = [];
      const records: unknown[] = [];
      const dt = [1 / 60, 1 / 120, 1 / 144, 0.05][variant % 4]!;
      let held = false;
      for (let f = 0; f < 600; f++) {
        const r = random();
        let command: unknown[] | undefined;
        if (r < 0.004) command = ['setAmmo', Math.floor(random() * 6), Math.floor(random() * 40)];
        else if (r < 0.007) command = ['cancel'];
        else if (r < 0.008) command = ['refill'];
        if (random() < 0.05) held = !held;
        const pressed = held && random() < 0.3;
        const reload = random() < 0.01;
        const ready = random() > 0.03;
        const frameDt = random() < 0.1 ? dt * (0.5 + random()) : dt;
        if (command) {
          if (command[0] === 'setAmmo') machine.setAmmo(command[1] as number, command[2] as number);
          else if (command[0] === 'cancel') machine.cancel();
          else machine.refill();
        }
        calls = [];
        machine.step(frameDt, { fireHeld: held, firePressed: pressed, reloadPressed: reload, ready }, sink);
        frames.push([frameDt, Number(held), Number(pressed), Number(reload), Number(ready), ...(command ? [command] : [])]);
        records.push([
          machine.magazine,
          machine.reserve,
          Number(machine.reloading),
          Number(machine.busy),
          Number(machine.cycling),
          Number(machine.chambered),
          machine.actionTime,
          calls,
        ]);
      }
      traces.push({ weapon: id, variant, frames, records });
    }
  }
  return traces;
}

/** stepGrenade from several launches; records [x, y, z, vx, vy, vz, resting, impact, surface] per step. */
export function grenadeTraces(world: CollisionWorld): unknown[] {
  const launches: { origin: number[]; velocity: number[] }[] = [];
  const throwFrom = (origin: number[], look: number[]) => {
    const forward = new Vector3(look[0], look[1], look[2]).normalize();
    const v = throwVelocity(forward, new Vector3());
    launches.push({ origin, velocity: [v.x, v.y, v.z] });
  };
  throwFrom([20, 1.45, 40], [1, 0, 0]);
  throwFrom([0, 1.45, 3], [0.2, 0.1, -1]);
  throwFrom([0, 1.5, 0], [0, 0.15, -1]);
  throwFrom([3, 1.6, -1], [-0.4, -0.5, -1]);
  throwFrom([-7, 1.5, -2], [0.6, 0.3, -1]);
  launches.push({ origin: [40, 2, 40], velocity: [0, 0, 0] });
  launches.push({ origin: [0, 1.5, 0], velocity: [0, 2, -14] });
  launches.push({ origin: [40, 30, 40], velocity: [6, 4, -3] });
  return launches.map((launch) => {
    const body = createGrenadeBody();
    body.position.set(launch.origin[0]!, launch.origin[1]!, launch.origin[2]!);
    body.velocity.set(launch.velocity[0]!, launch.velocity[1]!, launch.velocity[2]!);
    const steps: number[][] = [];
    for (let i = 0; i < 200; i++) {
      stepGrenade(body, world, GRENADE.step);
      const p = body.position;
      const v = body.velocity;
      steps.push([p.x, p.y, p.z, v.x, v.y, v.z, Number(body.resting), body.impact, SURFACES.indexOf(body.surface)]);
    }
    return { ...launch, steps };
  });
}

export function damageGrid(): unknown {
  const zones: HitZone[] = ['head', 'torso', 'limb'];
  const distances = [0, 5, 14, 20, 35, 50, 72.5, 110, 150, 400, 900];
  return Object.fromEntries(
    WEAPON_IDS.map((id) => [id, zones.map((zone) => distances.map((d) => damageAt(WEAPON_DEFS[id], d, zone)))]),
  );
}

export function blastCurve(): number[][] {
  const out: number[][] = [];
  for (let d = -0.5; d <= 9; d += 0.125) out.push([d, blastDamage(d)]);
  return out;
}
