import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../../src/core/events';
import { seededRandom } from '../../src/core/random';
import type {
  Combatant,
  CombatantHit,
  DamageInfo,
  GameContext,
  GameEvents,
  HitZone,
  ShotResult,
} from '../../src/game/contracts';
import { createBallisticsSystem } from '../../src/weapons/ballistics';
import { WEAPON_DEFS } from '../../src/weapons/defs';
import type { RayHit } from '../../src/world/types';

const DEG = Math.PI / 180;
const FORWARD = new Vector3(0, 0, -1);
/** No gun in the loadout fires more than one projectile, so pellets are tested on a made-up shell. */
const BUCKSHOT = { ...WEAPON_DEFS.mp5, pellets: 9, damage: 15, falloffStart: 8, falloffEnd: 32, range: 70 };

class Dummy implements Combatant {
  readonly team = 'bravo' as const;
  readonly name = 'dummy';
  readonly velocity = new Vector3();
  readonly crouching = false;
  readonly position: Vector3;
  alive = true;
  health = 100;
  readonly damage: DamageInfo[] = [];

  constructor(
    readonly id: number,
    readonly kind: Combatant['kind'],
    x = 0,
    z = 0,
  ) {
    this.position = new Vector3(x, 0, z);
  }

  eyePosition(target: Vector3): Vector3 {
    return target.copy(this.position).setY(this.position.y + 1.64);
  }

  hitTest(): CombatantHit | null {
    return null;
  }

  applyDamage(info: DamageInfo): void {
    this.damage.push({ ...info, point: info.point.clone(), direction: info.direction.clone() });
    this.health -= info.amount;
    if (this.health <= 0) this.alive = false;
  }
}

type Resolver = (origin: Vector3, direction: Vector3, max: number) => Partial<ShotResult> & { distance: number };

function setup(resolve: Resolver = (_o, _d, max) => ({ distance: max })) {
  const events = new EventBus<GameEvents>();
  const player = new Dummy(1, 'local', 0, 0);
  const bot = new Dummy(2, 'bot', 0, -30);
  const cameraPosition = new Vector3(0, 1.7, 0);
  const frames: (() => void)[] = [];
  const casts: { origin: Vector3; direction: Vector3; max: number; ignore: number }[] = [];
  const state = { time: 10 };
  const ctx = {
    events,
    player,
    engine: {
      camera: { position: cameraPosition },
      onFrame: (callback: () => void) => {
        frames.push(callback);
        return () => undefined;
      },
    },
    combat: {
      get: (id: number) => (id === player.id ? player : id === bot.id ? bot : undefined),
      raycast: (origin: Vector3, direction: Vector3, max: number, ignore: number): ShotResult => {
        casts.push({ origin: origin.clone(), direction: direction.clone(), max, ignore });
        const partial = resolve(origin, direction, max);
        return {
          world: null,
          combatant: null,
          combatantHit: null,
          end: origin.clone().addScaledVector(direction, partial.distance),
          ...partial,
        };
      },
    },
    get time() {
      return state.time;
    },
  } as unknown as GameContext;

  const seen: { [K in keyof GameEvents]?: GameEvents[K][] } = {};
  const record = <K extends keyof GameEvents>(type: K) => {
    const list: GameEvents[K][] = [];
    (seen as Record<string, unknown>)[type] = list;
    events.on(type, (payload) => list.push({ ...payload }));
    return list;
  };
  const log = {
    shotFired: record('shotFired'),
    bulletTrace: record('bulletTrace'),
    bulletImpact: record('bulletImpact'),
    combatantHit: record('combatantHit'),
    nearMiss: record('nearMiss'),
    casingEjected: record('casingEjected'),
  };
  const ballistics = createBallisticsSystem(ctx, seededRandom(11));
  const advance = (seconds: number) => {
    state.time += seconds;
    for (const frame of frames) frame();
  };
  return { ballistics, player, bot, log, casts, advance, state, cameraPosition };
}

function bodyHit(target: Combatant, distance: number, zone: HitZone): Resolver {
  return (origin, direction) => ({
    distance,
    combatant: target,
    combatantHit: { distance, zone, point: origin.clone().addScaledVector(direction, distance) },
  });
}

function wallHit(distance: number): Resolver {
  return (origin, direction) => {
    const hit: RayHit = {
      distance,
      point: origin.clone().addScaledVector(direction, distance),
      normal: direction.clone().negate(),
      surface: 'concrete',
    };
    return { distance, world: hit };
  };
}

describe('ballistics events', () => {
  it('announces one shot and one trace for a rifle round', () => {
    const { ballistics, player, log, casts } = setup();
    const muzzle = new Vector3(0.1, 1.5, -0.5);
    ballistics.fire(player, WEAPON_DEFS.m4a1, muzzle, FORWARD, 0);
    expect(log.shotFired.length).toBe(1);
    expect(log.shotFired[0]!.local).toBe(true);
    expect(log.shotFired[0]!.shooterId).toBe(1);
    expect(log.bulletTrace.length).toBe(1);
    expect(log.bulletTrace[0]!.from.equals(muzzle)).toBe(true);
    expect(casts[0]!.max).toBe(WEAPON_DEFS.m4a1.range);
    expect(casts[0]!.ignore).toBe(1);
  });

  it('fires every pellet of a multi-pellet round with one shot event', () => {
    const { ballistics, player, log, casts } = setup();
    ballistics.fire(player, BUCKSHOT, new Vector3(), FORWARD, 3);
    expect(log.shotFired.length).toBe(1);
    expect(log.bulletTrace.length).toBe(9);
    expect(casts.length).toBe(9);
    const distinct = new Set(casts.map((cast) => cast.direction.toArray().join(',')));
    expect(distinct.size).toBe(9);
    for (const cast of casts) expect(cast.direction.angleTo(FORWARD)).toBeLessThanOrEqual(3 * DEG + 1e-6);
  });

  it('uses the spread it is given, and the hip spread when given none', () => {
    const tight = setup();
    tight.ballistics.fire(tight.bot, WEAPON_DEFS.m4a1, new Vector3(), FORWARD, 0);
    expect(tight.casts[0]!.direction.angleTo(FORWARD)).toBeLessThan(1e-6);

    const loose = setup();
    let widest = 0;
    for (let i = 0; i < 200; i++) loose.ballistics.fire(loose.bot, WEAPON_DEFS.m4a1, new Vector3(), FORWARD);
    for (const cast of loose.casts) widest = Math.max(widest, cast.direction.angleTo(FORWARD) / DEG);
    expect(widest).toBeLessThanOrEqual(WEAPON_DEFS.m4a1.spreadHip + 1e-6);
    expect(widest).toBeGreaterThan(WEAPON_DEFS.m4a1.spreadHip * 0.8);
  });

  it('traces from the eye for the player and from the muzzle for everyone else', () => {
    const { ballistics, player, bot, casts, cameraPosition } = setup();
    const muzzle = new Vector3(0.2, 1.4, -0.6);
    ballistics.fire(player, WEAPON_DEFS.m4a1, muzzle, FORWARD, 0);
    ballistics.fire(bot, WEAPON_DEFS.m4a1, muzzle, FORWARD, 0);
    expect(casts[0]!.origin.equals(cameraPosition)).toBe(true);
    expect(casts[1]!.origin.equals(muzzle)).toBe(true);
  });

  it('reports a world impact', () => {
    const { ballistics, player, log } = setup(wallHit(12));
    ballistics.fire(player, WEAPON_DEFS.m4a1, new Vector3(), FORWARD, 0);
    expect(log.bulletImpact.length).toBe(1);
    expect(log.bulletImpact[0]!.hit.distance).toBe(12);
    expect(log.combatantHit.length).toBe(0);
  });
});

describe('ballistics damage', () => {
  it('applies falloff and the zone multiplier through applyDamage', () => {
    const def = WEAPON_DEFS.mp5; // full to 14 m, 0.5 at 50 m
    const target = new Dummy(7, 'bot');
    const { ballistics, player, log } = setup(bodyHit(target, 32, 'head'));
    ballistics.fire(player, def, new Vector3(), FORWARD, 0);
    expect(target.damage.length).toBe(1);
    const info = target.damage[0]!;
    expect(info.amount).toBeCloseTo(def.damage * 0.75 * def.headshotMultiplier, 5);
    expect(info.zone).toBe('head');
    expect(info.attackerId).toBe(1);
    expect(info.weaponId).toBe('mp5');
    expect(info.direction.angleTo(FORWARD)).toBeLessThan(1e-6);
    expect(log.combatantHit.length).toBe(1);
    expect(log.combatantHit[0]!.targetId).toBe(7);
    expect(log.combatantHit[0]!.fatal).toBe(false);
    expect(log.bulletImpact.length).toBe(0);
  });

  it('flags the fatal hit', () => {
    const target = new Dummy(7, 'bot');
    const { ballistics, player, log } = setup(bodyHit(target, 20, 'head'));
    ballistics.fire(player, WEAPON_DEFS.m24, new Vector3(), FORWARD, 0);
    expect(target.alive).toBe(false);
    expect(log.combatantHit[0]!.fatal).toBe(true);
  });

  it('sums the pellets that connect', () => {
    const def = BUCKSHOT;
    const target = new Dummy(7, 'bot');
    const { ballistics, player } = setup(bodyHit(target, 5, 'torso'));
    ballistics.fire(player, def, new Vector3(), FORWARD, 1);
    const total = target.damage.reduce((sum, info) => sum + info.amount, 0);
    expect(target.damage.length).toBeLessThanOrEqual(9);
    expect(total).toBeGreaterThanOrEqual(100);
    expect(target.alive).toBe(false);
  });
});

describe('bullet travel time', () => {
  it('lands at once inside 80 m', () => {
    const target = new Dummy(7, 'bot');
    const { ballistics, player } = setup(bodyHit(target, 79, 'torso'));
    ballistics.fire(player, WEAPON_DEFS.m24, new Vector3(), FORWARD, 0);
    expect(target.damage.length).toBe(1);
  });

  it('lands after distance / muzzle velocity beyond 80 m', () => {
    const def = WEAPON_DEFS.m24; // 790 m/s
    const target = new Dummy(7, 'bot');
    const { ballistics, player, log, advance } = setup(bodyHit(target, 395, 'torso'));
    ballistics.fire(player, def, new Vector3(), FORWARD, 0);
    expect(log.bulletTrace.length).toBe(1);
    expect(target.damage.length).toBe(0);
    advance(0.45);
    expect(target.damage.length).toBe(0);
    advance(0.06);
    expect(target.damage.length).toBe(1);
    expect(log.combatantHit.length).toBe(1);
    advance(1);
    expect(target.damage.length).toBe(1);
  });

  it('delays distant world impacts the same way', () => {
    const { ballistics, player, log, advance } = setup(wallHit(440));
    ballistics.fire(player, WEAPON_DEFS.m4a1, new Vector3(), FORWARD, 0);
    expect(log.bulletImpact.length).toBe(0);
    advance(0.51);
    expect(log.bulletImpact.length).toBe(1);
  });

  it('spares a target that died before the bullet arrived', () => {
    const target = new Dummy(7, 'bot');
    const { ballistics, player, log, advance } = setup(bodyHit(target, 395, 'torso'));
    ballistics.fire(player, WEAPON_DEFS.m24, new Vector3(), FORWARD, 0);
    target.alive = false;
    advance(1);
    expect(target.damage.length).toBe(0);
    expect(log.combatantHit.length).toBe(0);
  });

  it('forgets bullets in flight when the match clock restarts', () => {
    const target = new Dummy(7, 'bot');
    const { ballistics, player, advance, state } = setup(bodyHit(target, 395, 'torso'));
    ballistics.fire(player, WEAPON_DEFS.m24, new Vector3(), FORWARD, 0);
    state.time = 0;
    advance(0);
    advance(30);
    expect(target.damage.length).toBe(0);
  });
});

describe('near misses', () => {
  const botMuzzle = new Vector3(0.8, 1.6, -30);
  const towardPlayer = new Vector3(0, 0, 1);

  it('fires when a bot round passes within 1.2 m of the player head', () => {
    const { ballistics, bot, log } = setup((_o, _d, max) => ({ distance: Math.min(max, 60) }));
    ballistics.fire(bot, WEAPON_DEFS.m4a1, botMuzzle, towardPlayer, 0);
    expect(log.nearMiss.length).toBe(1);
    expect(log.nearMiss[0]!.point.distanceTo(new Vector3(0.8, 1.6, 0))).toBeLessThan(0.05);
  });

  it('stays quiet for a wide miss', () => {
    const { ballistics, bot, log } = setup((_o, _d, max) => ({ distance: Math.min(max, 60) }));
    ballistics.fire(bot, WEAPON_DEFS.m4a1, new Vector3(3, 1.6, -30), towardPlayer, 0);
    expect(log.nearMiss.length).toBe(0);
  });

  it('stays quiet when the round stops short of the player', () => {
    const { ballistics, bot, log } = setup(wallHit(20));
    ballistics.fire(bot, WEAPON_DEFS.m4a1, botMuzzle, towardPlayer, 0);
    expect(log.nearMiss.length).toBe(0);
  });

  it('stays quiet when the round hits the player', () => {
    const holder: { player: Combatant | null } = { player: null };
    const hit = setup((origin, direction, max) => bodyHit(holder.player!, 30, 'torso')(origin, direction, max));
    holder.player = hit.player;
    hit.ballistics.fire(hit.bot, WEAPON_DEFS.m4a1, botMuzzle, towardPlayer, 0);
    expect(hit.log.nearMiss.length).toBe(0);
  });

  it('never fires for the player own shots, and at most once per shell', () => {
    const own = setup();
    own.ballistics.fire(own.player, WEAPON_DEFS.m4a1, new Vector3(0, 1.6, -1), FORWARD, 0);
    expect(own.log.nearMiss.length).toBe(0);
    const shell = setup((_o, _d, max) => ({ distance: Math.min(max, 60) }));
    shell.ballistics.fire(shell.bot, BUCKSHOT, botMuzzle, towardPlayer, 0.5);
    expect(shell.log.nearMiss.length).toBe(1);
  });
});

describe('casings from other shooters', () => {
  it('ejects at once from a self-loading gun', () => {
    const { ballistics, bot, log } = setup();
    ballistics.fire(bot, WEAPON_DEFS.m4a1, new Vector3(0, 1.5, -30), FORWARD, 0);
    expect(log.casingEjected.length).toBe(1);
    expect(log.casingEjected[0]!.kind).toBe('rifle');
  });

  it('waits for the bolt on a bolt-action gun', () => {
    const { ballistics, bot, log, advance } = setup();
    ballistics.fire(bot, WEAPON_DEFS.m24, new Vector3(0, 1.5, -30), FORWARD, 0);
    expect(log.casingEjected.length).toBe(0);
    advance(1);
    expect(log.casingEjected.length).toBe(1);
  });

  it('leaves the player casings to the view model', () => {
    const { ballistics, player, log, advance } = setup();
    ballistics.fire(player, WEAPON_DEFS.m4a1, new Vector3(), FORWARD, 0);
    advance(1);
    expect(log.casingEjected.length).toBe(0);
  });
});
