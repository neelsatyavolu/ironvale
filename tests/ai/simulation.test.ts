import { Box3, Line3, Vector3 } from 'three/webgpu';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/core/events';
import type { Difficulty } from '../../src/core/settings';
import { Combat } from '../../src/game/combat';
import type { Combatant, GameContext, GameEvents, SoldierVisual, WeaponDef } from '../../src/game/contracts';
import { hitTestHumanoid } from '../../src/game/hitbox';
import { DIFFICULTY } from '../../src/ai/difficulty';
import { WEAPON_DEFS } from '../../src/weapons/defs';
import type { MapInstance } from '../../src/world/types';
import { buildTestWorld, TEST_BOUNDS } from './helpers';

// The real soldier needs loaded models; the simulation only needs something to drive.
vi.mock('../../src/characters/index', async () => {
  const three = await import('three/webgpu');
  return {
    soldierAssets: () => [],
    createSoldier: (): SoldierVisual => {
      const root = new three.Group();
      return {
        root,
        muzzleWorld: (target) => target.copy(root.position).setY(root.position.y + 1.3),
        setState: () => undefined,
        die: vi.fn(),
        revive: () => undefined,
        flinch: () => undefined,
        update: () => undefined,
        dispose: () => undefined,
      };
    },
  };
});

const { createBots } = await import('../../src/ai/index');

interface Shot {
  readonly shooter: Combatant;
  readonly weapon: WeaponDef;
  readonly spread: number | undefined;
  readonly time: number;
  readonly aimOffset: number;
  /** Closest a squad mate stood to the bullet's path to the player, in metres. */
  readonly mateClearance: number;
}

function makeGame(playerAt: Vector3) {
  const world = buildTestWorld();
  const events = new EventBus<GameEvents>();
  const combat = new Combat(() => world);
  const scene = { add: vi.fn(), remove: vi.fn() };
  const shots: Shot[] = [];
  const clock = { time: 0 };
  const player = {
    id: combat.allocateId(),
    kind: 'local' as const,
    team: 'alpha' as const,
    name: 'You',
    alive: true,
    health: 100,
    position: playerAt.clone(),
    velocity: new Vector3(),
    crouching: false,
    yaw: 0,
    eyePosition: (target: Vector3) => target.copy(player.position).setY(player.position.y + 1.64),
    hitTest: (origin: Vector3, direction: Vector3, max: number) => hitTestHumanoid(player.position, false, origin, direction, max),
    applyDamage: () => undefined,
  };
  combat.add(player);
  const spawn = (x: number, z: number) => ({ position: new Vector3(x, 0.05, z), yaw: 0 });
  const map = {
    bounds: new Box3().copy(TEST_BOUNDS),
    enemySpawns: [spawn(-14, -14), spawn(14, -14), spawn(-14, 14)],
    playerSpawns: [spawn(0, 5)],
    lighting: { fog: { density: 0.006 } },
  } as unknown as MapInstance;
  const ctx = {
    engine: { scene, camera: { position: new Vector3() } },
    assets: { preload: async () => undefined },
    events,
    world,
    combat,
    player,
    map,
    ballistics: {
      fire: (shooter: Combatant, weapon: WeaponDef, muzzle: Vector3, direction: Vector3, spread?: number) => {
        const chest = player.position.clone().setY(player.position.y + 1.2);
        const toPlayer = chest.clone().sub(muzzle).normalize();
        const path = new Line3(muzzle.clone(), chest);
        const nearest = new Vector3();
        let mateClearance = Infinity;
        for (const other of combat.all()) {
          if (other === shooter || other === player || !other.alive) continue;
          const at = other.position.clone().setY(other.position.y + 1.2);
          const t = path.closestPointToPointParameter(at, false);
          if (t <= 0 || t >= 1) continue;
          mateClearance = Math.min(mateClearance, path.at(t, nearest).distanceTo(at));
        }
        shots.push({ shooter, weapon, spread, time: clock.time, aimOffset: toPlayer.angleTo(direction), mateClearance });
        events.emit('shotFired', { shooterId: shooter.id, weapon, muzzle, direction, local: false });
      },
    },
  } as unknown as GameContext;
  const bots = createBots(ctx);
  const run = (seconds: number, each?: () => void) => {
    for (let t = 0; t < seconds; t += 1 / 60) {
      clock.time += 1 / 60;
      bots.update(1 / 60);
      each?.();
    }
  };
  return { ctx, bots, combat, events, scene, shots, player, map, run, clock };
}

type Game = ReturnType<typeof makeGame>;

async function start(playerAt: Vector3, count: number, difficulty: Difficulty): Promise<Game> {
  const game = makeGame(playerAt);
  await game.bots.enterMap(game.map);
  game.bots.spawn(count, 'bravo', difficulty);
  return game;
}

const living = (game: Game) => game.combat.all().filter((c) => c.kind === 'bot' && c.alive);

describe('bot system in a simulated match', () => {
  let game: Game;

  beforeEach(async () => {
    game = await start(new Vector3(0, 0, 5), 6, 'regular');
  });

  it('spawns the squad on enemy spawns, registered and counted', () => {
    expect(game.bots.alive).toBe(6);
    const bots = living(game);
    expect(bots).toHaveLength(6);
    expect(game.scene.add).toHaveBeenCalledTimes(6);
    for (const bot of bots) {
      expect(bot.team).toBe('bravo');
      expect(bot.health).toBeGreaterThan(0);
      const nearest = Math.min(...game.map.enemySpawns.map((s) => s.position.distanceTo(bot.position)));
      expect(nearest).toBeLessThan(3);
    }
    // No two soldiers share a spot.
    for (let i = 0; i < bots.length; i++) {
      for (let j = i + 1; j < bots.length; j++) expect(bots[i]!.position.distanceTo(bots[j]!.position)).toBeGreaterThan(0.5);
    }
  });

  it('leaves the spawns, finds the player and opens fire with its own weapons', () => {
    const starts = living(game).map((bot) => bot.position.clone());
    game.run(60);
    const moved = living(game).filter((bot, i) => bot.position.distanceTo(starts[i]!) > 3);
    expect(moved.length).toBeGreaterThanOrEqual(4);
    expect(game.shots.length).toBeGreaterThan(10);
    const used = new Set(game.shots.map((shot) => shot.weapon.id));
    for (const id of used) expect(['m4a1', 'mp5', 'm24', 'm249']).toContain(id);
    for (const shot of game.shots) {
      expect(shot.shooter.kind).toBe('bot');
      expect(shot.spread).toBeGreaterThan(0);
      // Scaled copy, not the shared definition; the sniper keeps full damage so it still kills in one hit.
      const scale = shot.weapon.weaponClass === 'sniper' ? 1 : DIFFICULTY.regular.damageMultiplier;
      expect(shot.weapon.damage).toBeCloseTo(WEAPON_DEFS[shot.weapon.id as 'm4a1'].damage * scale, 5);
      // Fired at the player, not into the sky or through a mate.
      expect(shot.aimOffset).toBeLessThan(0.2);
    }
  });

  it('holds fire when a squad mate is in the way', () => {
    game.run(90);
    expect(game.shots.length).toBeGreaterThan(50);
    for (const shot of game.shots) expect(shot.mateClearance).toBeGreaterThan(0.6);
  });

  it('never fires faster than the weapon allows', () => {
    game.run(60);
    const byShooter = new Map<number, Shot[]>();
    for (const shot of game.shots) byShooter.set(shot.shooter.id, [...(byShooter.get(shot.shooter.id) ?? []), shot]);
    expect(byShooter.size).toBeGreaterThan(0);
    for (const list of byShooter.values()) {
      for (let i = 1; i < list.length; i++) {
        const interval = 60 / list[i]!.weapon.roundsPerMinute;
        expect(list[i]!.time - list[i - 1]!.time).toBeGreaterThan(interval - 1 / 60 - 1e-6);
      }
    }
  });

  it('is slower to open fire on recruit than on elite', async () => {
    const firstShot = async (difficulty: Difficulty) => {
      const match = await start(new Vector3(-8, 0, -12), 3, difficulty);
      match.run(30);
      return match.shots[0]?.time ?? Infinity;
    };
    const elite = await firstShot('elite');
    const recruit = await firstShot('recruit');
    expect(elite).toBeLessThan(30);
    expect(recruit).toBeGreaterThan(elite);
  });

  it('goes to look at a gunshot it hears', () => {
    // Player behind the tall wall: out of sight of every spawn at first.
    game.player.position.set(0, 0, -4);
    const before = living(game).map((bot) => bot.position.distanceTo(game.player.position));
    game.events.emit('shotFired', {
      shooterId: game.player.id,
      weapon: WEAPON_DEFS.m4a1,
      muzzle: new Vector3(0, 1.4, -4),
      direction: new Vector3(0, 0, 1),
      local: true,
    });
    game.run(6);
    const closer = living(game).filter((bot, i) => bot.position.distanceTo(game.player.position) < before[i]! - 2);
    expect(closer.length).toBeGreaterThanOrEqual(3);
  });

  it('dies once, tells the game, leaves a body for about 20 seconds and then cleans up', () => {
    const died: GameEvents['died'][] = [];
    const callouts: string[] = [];
    game.events.on('died', (event) => died.push({ ...event }));
    game.events.on('botCallout', (event) => callouts.push(event.kind));
    const victim = living(game)[0]!;
    const hit = { zone: 'head' as const, attackerId: game.player.id, weaponId: 'm4a1', point: new Vector3(), direction: new Vector3(0, 0, -1) };
    victim.applyDamage({ ...hit, amount: 30 });
    expect(victim.alive).toBe(true);
    expect(victim.health).toBeLessThan(85);
    victim.applyDamage({ ...hit, amount: 500 });
    victim.applyDamage({ ...hit, amount: 500 });
    expect(victim.alive).toBe(false);
    expect(victim.health).toBe(0);
    expect(died).toEqual([{ victimId: victim.id, killerId: game.player.id, weaponId: 'm4a1', headshot: true }]);
    expect(callouts).toContain('death');
    expect(game.bots.alive).toBe(5);
    game.run(18);
    expect(game.combat.get(victim.id)).toBe(victim);
    game.run(3);
    expect(game.combat.get(victim.id)).toBeUndefined();
    expect(game.scene.remove).toHaveBeenCalledTimes(1);
  });

  it('takes no damage from its own squad', () => {
    const [victim, mate] = living(game);
    const before = victim!.health;
    victim!.applyDamage({ amount: 60, zone: 'torso', attackerId: mate!.id, weaponId: 'm4a1', point: new Vector3(), direction: new Vector3(0, 0, -1) });
    expect(victim!.health).toBe(before);
    victim!.applyDamage({ amount: 60, zone: 'torso', attackerId: game.player.id, weaponId: 'm4a1', point: new Vector3(), direction: new Vector3(0, 0, -1) });
    expect(victim!.health).toBe(before - 60);
  });

  it('reacts to being shot by turning on the shooter', () => {
    // Behind a soldier that faces away (spawn yaw 0 looks down -Z).
    game.player.position.set(16, 0, -4);
    const post = new Vector3(14, 0, -14);
    const victim = living(game).find((bot) => bot.position.distanceTo(post) < 0.5)!;
    expect(game.shots).toHaveLength(0);
    victim.applyDamage({ amount: 10, zone: 'torso', attackerId: game.player.id, weaponId: 'm4a1', point: new Vector3(), direction: new Vector3(0, 0, -1) });
    game.run(4);
    expect(game.shots.some((shot) => shot.shooter.id === victim.id) || victim.position.distanceTo(post) > 1).toBe(true);
  });

  it('clears everything when the map is left', () => {
    game.bots.leaveMap();
    expect(game.bots.alive).toBe(0);
    expect(living(game)).toHaveLength(0);
    expect(game.scene.remove).toHaveBeenCalledTimes(6);
    expect(() => game.bots.update(1 / 60)).not.toThrow();
  });

  it('keeps twelve soldiers well inside the frame budget', async () => {
    const match = await start(new Vector3(0, 0, 5), 12, 'veteran');
    match.run(5);
    const frames = 60 * 30;
    const begin = performance.now();
    match.run(30);
    const perFrame = (performance.now() - begin) / frames;
    // Target is 1.5 ms on a MacBook; leave room for a busy test machine.
    expect(perFrame).toBeLessThan(1.5);
  });
});
