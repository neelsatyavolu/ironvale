import { describe, expect, it } from 'vitest';
import type { WeaponActionStage } from '../../src/game/contracts';
import { WEAPON_DEFS } from '../../src/weapons/defs';
import { WeaponMachine, type MachineSink, type TriggerInput } from '../../src/weapons/machine';
import { shotInterval } from '../../src/weapons/math';

const DT = 1 / 120;
const IDLE: TriggerInput = { fireHeld: false, firePressed: false, reloadPressed: false, ready: true };
const HOLD: TriggerInput = { ...IDLE, fireHeld: true };
const PRESS: TriggerInput = { ...IDLE, fireHeld: true, firePressed: true };
const RELOAD: TriggerInput = { ...IDLE, reloadPressed: true };

interface Log {
  time: number;
  shots: number[];
  dry: number[];
  stages: { stage: WeaponActionStage; time: number }[];
  ejects: number[];
  clips: number[];
  lastRound: boolean[];
}

function rig(id: keyof typeof WEAPON_DEFS) {
  const log: Log = { time: 0, shots: [], dry: [], stages: [], ejects: [], clips: [], lastRound: [] };
  const sink: MachineSink = {
    fire: (last) => {
      log.shots.push(log.time);
      log.lastRound.push(last);
    },
    dryFire: () => log.dry.push(log.time),
    stage: (stage) => log.stages.push({ stage, time: log.time }),
    eject: () => log.ejects.push(log.time),
    clipEject: () => log.clips.push(log.time),
  };
  const machine = new WeaponMachine(WEAPON_DEFS[id]);
  const step = (input: TriggerInput, dt = DT) => {
    machine.step(dt, input, sink);
    log.time += dt;
  };
  const run = (seconds: number, input: TriggerInput = IDLE, dt = DT) => {
    const steps = Math.round(seconds / dt);
    for (let i = 0; i < steps; i++) step(input, dt);
  };
  /** Press for one frame, then hold or release. */
  const tap = () => {
    step(PRESS);
    step(IDLE);
  };
  const stages = () => log.stages.map((entry) => entry.stage);
  const settle = () => {
    for (let i = 0; i < 4000 && (machine.busy || machine.reloading); i++) step(IDLE);
  };
  return { machine, log, step, run, tap, stages, settle };
}

describe('automatic fire', () => {
  it('fires at the rate of fire while the trigger is held', () => {
    for (const dt of [1 / 240, 1 / 60, 1 / 30]) {
      const { log, step, run } = rig('m4a1');
      step(PRESS, dt);
      run(1.02 - dt, HOLD, dt);
      // 800 rpm: one shot every 75 ms, so shots at 0, 75, ... 975 ms.
      expect(log.shots.length).toBe(14);
    }
  });

  it('spaces shots by the interval', () => {
    const { log, step, run } = rig('m4a1');
    step(PRESS);
    run(0.5, HOLD);
    const interval = shotInterval(WEAPON_DEFS.m4a1);
    for (let i = 1; i < log.shots.length; i++) {
      expect(log.shots[i]! - log.shots[i - 1]!).toBeGreaterThan(interval - DT * 1.01);
      expect(log.shots[i]! - log.shots[i - 1]!).toBeLessThan(interval + DT * 1.01);
    }
  });

  it('fires one round for a quick tap and stops on release', () => {
    const { machine, log, tap, run } = rig('m4a1');
    tap();
    run(0.5);
    expect(log.shots.length).toBe(1);
    expect(machine.magazine).toBe(29);
  });

  it('ejects a casing with every shot', () => {
    const { log, step, run } = rig('mp5');
    step(PRESS);
    run(0.3, HOLD);
    expect(log.ejects.length).toBe(log.shots.length);
  });

  it('does not catch up with a burst after a pause', () => {
    const { log, step, run } = rig('m4a1');
    run(2);
    step(PRESS);
    step(HOLD);
    step(HOLD);
    expect(log.shots.length).toBe(1);
  });
});

describe('semi-automatic fire', () => {
  it('fires once per press however long the trigger is held', () => {
    const { log, step, run } = rig('m1garand');
    step(PRESS);
    run(1, HOLD);
    expect(log.shots.length).toBe(1);
  });

  it('buffers a press made during the cooldown and fires when it ends', () => {
    const { log, tap, run } = rig('m1garand');
    const interval = shotInterval(WEAPON_DEFS.m1garand);
    tap();
    run(0.06);
    tap(); // about 80 ms in, well inside the 187 ms cooldown
    run(0.5);
    expect(log.shots.length).toBe(2);
    expect(log.shots[1]!).toBeGreaterThanOrEqual(interval - DT);
    expect(log.shots[1]!).toBeLessThan(interval + 2 * DT);
  });

  it('does not eat fast taps, and never exceeds the rate of fire', () => {
    const { log, tap, run } = rig('m1911');
    // Ten taps a second for 0.7 s against a 158 ms cooldown.
    for (let i = 0; i < 7; i++) {
      tap();
      run(0.1 - 2 * DT);
    }
    run(0.4);
    const interval = shotInterval(WEAPON_DEFS.m1911);
    expect(log.shots.length).toBe(5);
    for (let i = 1; i < log.shots.length; i++) {
      expect(log.shots[i]! - log.shots[i - 1]!).toBeGreaterThan(interval - DT * 1.01);
    }
  });

  it('keeps only one shot in the buffer', () => {
    const { log, tap, run } = rig('m1garand');
    tap();
    tap();
    tap();
    tap();
    run(1);
    expect(log.shots.length).toBe(2);
  });

  it('lets a buffered press lapse when the wait is long', () => {
    const { log, tap, run } = rig('m24');
    tap();
    run(0.3);
    tap(); // the bolt cycle has more than a second to go
    run(3);
    expect(log.shots.length).toBe(1);
  });

  it('holds a press while the gun is not ready and fires when it is', () => {
    const { log, step, run } = rig('m1911');
    step({ ...PRESS, ready: false });
    run(0.4, { ...IDLE, ready: false });
    expect(log.shots.length).toBe(0);
    step(IDLE);
    expect(log.shots.length).toBe(1);
  });
});

describe('dry fire and automatic reload', () => {
  it('clicks once per press on an empty gun with no reserve', () => {
    const { machine, log, step, run, tap } = rig('m1911');
    machine.setAmmo(0, 0);
    step(PRESS);
    run(0.5, HOLD);
    expect(log.dry.length).toBe(1);
    tap();
    expect(log.dry.length).toBe(2);
    expect(log.shots.length).toBe(0);
    expect(machine.reloading).toBe(false);
  });

  it('clicks and starts a reload when there is reserve ammo', () => {
    const { machine, log, tap } = rig('m4a1');
    machine.setAmmo(0, 60);
    tap();
    expect(log.dry.length).toBe(1);
    expect(machine.reloading).toBe(true);
  });

  it('does not click when an automatic runs dry mid-burst', () => {
    const { machine, log, step, run } = rig('m4a1');
    machine.setAmmo(3, 0);
    step(PRESS);
    run(1, HOLD);
    expect(log.shots.length).toBe(3);
    expect(log.dry.length).toBe(0);
  });
});

describe('magazine reload', () => {
  it('keeps the chambered round on a partly used magazine', () => {
    const { machine, log, step, stages, settle } = rig('m4a1');
    machine.setAmmo(12, 150);
    step(RELOAD);
    expect(machine.reloading).toBe(true);
    settle();
    expect(stages()).toEqual(['magOut', 'magIn']);
    expect(machine.magazine).toBe(31);
    expect(machine.reserve).toBe(150 - 19);
    expect(log.time).toBeLessThan(WEAPON_DEFS.m4a1.reloadTime);
  });

  it('releases the bolt only when the chamber was empty', () => {
    const { machine, log, step, stages, settle } = rig('m4a1');
    machine.setAmmo(0, 150);
    step(RELOAD);
    settle();
    expect(stages()).toEqual(['magOut', 'magIn', 'boltForward']);
    expect(machine.magazine).toBe(30);
    expect(machine.reserve).toBe(120);
    expect(log.time).toBeCloseTo(WEAPON_DEFS.m4a1.reloadTime, 1);
  });

  it('drops the slide on an empty pistol', () => {
    const { machine, step, stages, settle } = rig('m1911');
    machine.setAmmo(0, 49);
    step(RELOAD);
    settle();
    expect(stages()).toEqual(['magOut', 'magIn', 'slideRelease']);
    expect(machine.magazine).toBe(7);
  });

  it('loads what is left when the reserve is short', () => {
    const { machine, step, settle } = rig('m4a1');
    machine.setAmmo(5, 10);
    step(RELOAD);
    settle();
    expect(machine.magazine).toBe(15);
    expect(machine.reserve).toBe(0);
  });

  it('refuses when full or when there is no reserve', () => {
    const full = rig('m4a1');
    full.machine.setAmmo(31, 100);
    full.step(RELOAD);
    expect(full.machine.reloading).toBe(false);
    const dry = rig('m4a1');
    dry.machine.setAmmo(4, 0);
    dry.step(RELOAD);
    expect(dry.machine.reloading).toBe(false);
  });

  it('blocks fire until the reload is done', () => {
    const { machine, log, step, run, settle } = rig('m4a1');
    machine.setAmmo(12, 150);
    step(RELOAD);
    step(PRESS);
    run(0.5, HOLD);
    expect(log.shots.length).toBe(0);
    settle();
    step(PRESS);
    expect(log.shots.length).toBe(1);
  });

  it('leaves ammo alone when cancelled before the new magazine is in', () => {
    const { machine, step, run } = rig('m4a1');
    machine.setAmmo(12, 150);
    step(RELOAD);
    run(0.3);
    machine.cancel();
    expect(machine.reloading).toBe(false);
    expect(machine.magazine).toBe(12);
    expect(machine.reserve).toBe(150);
  });

  it('keeps the new magazine when cancelled after it is in', () => {
    const { machine, step, run, stages } = rig('m4a1');
    machine.setAmmo(0, 150);
    step(RELOAD);
    while (!stages().includes('magIn')) run(DT);
    machine.cancel();
    expect(machine.magazine).toBe(30);
    // The bolt still has to go forward before the gun fires.
    step(IDLE);
    expect(machine.busy).toBe(true);
  });
});

describe('M1 Garand en-bloc clip', () => {
  it('pings and throws the clip with the eighth shot', () => {
    const { machine, log, tap, run, stages } = rig('m1garand');
    for (let i = 0; i < 8; i++) {
      tap();
      run(0.25);
    }
    expect(log.shots.length).toBe(8);
    expect(log.lastRound.filter(Boolean).length).toBe(1);
    expect(stages()).toEqual(['clipPing']);
    expect(log.clips.length).toBe(1);
    expect(log.clips[0]).toBe(log.shots[7]);
    expect(log.ejects.length).toBe(8);
    expect(machine.magazine).toBe(0);
  });

  it('loads a full clip into an empty rifle', () => {
    const { machine, log, step, stages, settle } = rig('m1garand');
    machine.setAmmo(0, 64);
    step(RELOAD);
    settle();
    expect(stages()).toEqual(['clipInsert', 'boltForward']);
    expect(machine.magazine).toBe(8);
    expect(machine.reserve).toBe(56);
    expect(log.time).toBeCloseTo(WEAPON_DEFS.m1garand.reloadTime, 1);
  });

  it('swaps a partly used clip and keeps the loose rounds', () => {
    const { machine, log, step, stages, settle } = rig('m1garand');
    machine.setAmmo(5, 64);
    step(RELOAD);
    settle();
    expect(stages()).toEqual(['boltBack', 'magOut', 'clipInsert', 'boltForward']);
    expect(machine.magazine).toBe(8);
    expect(machine.reserve).toBe(61);
    expect(log.clips.length).toBe(1);
  });
});

describe('pump shotgun', () => {
  it('pumps between shots and ejects on the back stroke', () => {
    const { log, tap, run, stages } = rig('r870');
    tap();
    expect(log.ejects.length).toBe(0);
    run(1.2);
    expect(stages()).toEqual(['pumpBack', 'pumpForward']);
    expect(log.ejects.length).toBe(1);
    expect(log.ejects[0]).toBeCloseTo(log.stages[0]!.time, 5);
  });

  it('cannot fire again until the pump is done', () => {
    const { log, step, run } = rig('r870');
    const interval = shotInterval(WEAPON_DEFS.r870);
    step(PRESS);
    run(interval - 0.15);
    step(PRESS);
    run(0.6);
    expect(log.shots.length).toBe(2);
    expect(log.shots[1]!).toBeGreaterThanOrEqual(interval - DT);
  });

  it('loads one shell at a time', () => {
    const { machine, log, step, stages, settle } = rig('r870');
    machine.setAmmo(2, 36);
    step(RELOAD);
    settle();
    expect(stages()).toEqual(['shellInsert', 'shellInsert', 'shellInsert', 'shellInsert']);
    expect(machine.magazine).toBe(6);
    expect(machine.reserve).toBe(32);
    const gap = log.stages[1]!.time - log.stages[0]!.time;
    expect(gap).toBeCloseTo(WEAPON_DEFS.r870.reloadTime, 2);
  });

  it('does not pump after the last shell, and pumps at the end of the reload instead', () => {
    const { machine, log, tap, step, run, stages, settle } = rig('r870');
    machine.setAmmo(1, 2);
    tap();
    run(1.5);
    expect(stages()).toEqual([]);
    expect(log.ejects.length).toBe(0);
    step(RELOAD);
    settle();
    expect(stages()).toEqual(['shellInsert', 'shellInsert', 'pumpBack', 'pumpForward']);
    expect(log.ejects.length).toBe(1);
    expect(machine.magazine).toBe(2);
    expect(machine.reserve).toBe(0);
  });

  it('stops loading when fire is pressed and shoots', () => {
    const { machine, log, step, run, stages } = rig('r870');
    machine.setAmmo(2, 36);
    step(RELOAD);
    while (stages().length < 2) run(DT);
    step(PRESS);
    run(0.5);
    expect(log.shots.length).toBe(1);
    expect(stages().filter((stage) => stage === 'shellInsert').length).toBe(2);
    expect(machine.magazine).toBe(3);
    expect(machine.reserve).toBe(34);
  });

  it('pumps first when interrupted with an empty chamber', () => {
    const { machine, log, tap, step, run, stages } = rig('r870');
    machine.setAmmo(1, 36);
    tap();
    run(1);
    step(RELOAD);
    while (stages().length < 1) run(DT);
    step(PRESS);
    run(1.5);
    expect(stages().slice(0, 3)).toEqual(['shellInsert', 'pumpBack', 'pumpForward']);
    expect(log.shots.length).toBe(2);
    expect(log.shots[1]!).toBeGreaterThan(log.stages[2]!.time - DT);
  });

  it('ignores the trigger while there is still nothing loaded', () => {
    const { machine, log, step, run } = rig('r870');
    machine.setAmmo(1, 36);
    step(PRESS);
    run(1);
    step(RELOAD);
    step(PRESS);
    run(0.1);
    expect(machine.reloading).toBe(true);
    expect(log.dry.length).toBe(0);
  });
});

describe('bolt action', () => {
  it('cycles the bolt after a shot and ejects as it comes back', () => {
    const { log, tap, run, stages } = rig('m24');
    tap();
    run(2);
    expect(stages()).toEqual(['boltLift', 'boltBack', 'boltForward', 'boltClose']);
    expect(log.ejects.length).toBe(1);
    expect(log.ejects[0]).toBeCloseTo(log.stages[1]!.time, 5);
  });

  it('reports the cycle so the view can leave the scope', () => {
    const { machine, tap, run } = rig('m24');
    tap();
    run(0.6);
    expect(machine.cycling).toBe(true);
    run(1.5);
    expect(machine.cycling).toBe(false);
  });

  it('fires again only after the full cycle', () => {
    const { log, step, run } = rig('m24');
    const interval = shotInterval(WEAPON_DEFS.m24);
    step(PRESS);
    run(interval - 0.1);
    step(PRESS);
    run(0.3);
    expect(log.shots.length).toBe(2);
    expect(log.shots[1]!).toBeGreaterThanOrEqual(interval - DT);
  });

  it('leaves the bolt closed on the last round and works it during the reload', () => {
    const { machine, log, tap, step, run, stages, settle } = rig('m24');
    machine.setAmmo(1, 30);
    tap();
    run(2);
    expect(stages()).toEqual([]);
    step(RELOAD);
    settle();
    expect(stages()).toEqual(['magOut', 'magIn', 'boltLift', 'boltBack', 'boltForward', 'boltClose']);
    expect(log.ejects.length).toBe(1);
    expect(machine.magazine).toBe(5);
  });

  it('tops up with a round still chambered', () => {
    const { machine, tap, step, run, stages, settle } = rig('m24');
    tap();
    run(2);
    step(RELOAD);
    settle();
    expect(stages().slice(4)).toEqual(['magOut', 'magIn']);
    expect(machine.magazine).toBe(6);
    expect(machine.reserve).toBe(28);
  });

  it('finishes an interrupted cycle before firing', () => {
    const { machine, log, tap, step, run } = rig('m24');
    tap();
    run(0.2);
    machine.cancel();
    step(PRESS);
    run(0.2);
    expect(log.shots.length).toBe(1);
    expect(machine.cycling).toBe(true);
    run(2);
    expect(log.ejects.length).toBe(1);
  });
});

describe('belt-fed reload', () => {
  it('opens the cover, changes the belt and closes it', () => {
    const { machine, log, step, stages, settle } = rig('m249');
    machine.setAmmo(40, 200);
    step(RELOAD);
    settle();
    expect(stages()).toEqual(['beltOpen', 'magOut', 'magIn', 'beltClose']);
    expect(machine.magazine).toBe(100);
    expect(machine.reserve).toBe(140);
    expect(log.time).toBeCloseTo(WEAPON_DEFS.m249.reloadTime, 1);
  });

  it('charges the bolt when it ran dry', () => {
    const { machine, step, stages, settle } = rig('m249');
    machine.setAmmo(0, 60);
    step(RELOAD);
    settle();
    expect(stages()).toEqual(['beltOpen', 'magOut', 'magIn', 'beltClose', 'boltBack']);
    expect(machine.magazine).toBe(60);
    expect(machine.reserve).toBe(0);
  });
});

describe('refill', () => {
  it('restores a full magazine and reserve and clears any action', () => {
    const { machine, step, run } = rig('m4a1');
    machine.setAmmo(0, 10);
    step(RELOAD);
    run(0.2);
    machine.refill();
    expect(machine.reloading).toBe(false);
    expect(machine.magazine).toBe(30);
    expect(machine.reserve).toBe(150);
  });
});
