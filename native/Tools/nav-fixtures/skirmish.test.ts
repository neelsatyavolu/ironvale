/**
 * The web's solo skirmish, headless (M7b reference): the real src/ai BotManager, Combat and ballistics on
 * a map's real CollisionWorld (rebuilt from native/MapPackages), 8 bravo bots against a player who stands
 * at the spawn and never shoots, as native/IronvaleKit/Tests/IronvaleAITests/SkirmishTests.swift plays it
 * natively. Only the soldier visuals are stubs: the muzzle is the native port's renderer-free muzzle (a
 * fixed point ahead of the eye), since the web takes it from the animated rifle model.
 * Prints, per map and seed, which bots fired (by role), when each fired first and how the match ended,
 * and writes native/Contract/nav/skirmish.json (the web's range over 16 matches per map), which the
 * native skirmish gate (IronvaleAI BotScenarioMonitor, SkirmishReference) holds native runs to.
 * Part of native/Tools/nav-fixtures/run.sh [--check]. Exploring: SKIRMISH_SEEDS, SKIRMISH_MAPS and
 * SKIRMISH_SECONDS change the run and skip the fixture.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Box3, Object3D, Vector3 } from 'three/webgpu';
import { expect, it } from 'vitest';
import { BotManager } from '../../../src/ai/manager';
import { EventBus } from '../../../src/core/events';
import { seededRandom } from '../../../src/core/random';
import { Combat } from '../../../src/game/combat';
import type { Combatant, CombatantHit, DamageInfo, GameEvents, SoldierVisual } from '../../../src/game/contracts';
import { hitTestHumanoid } from '../../../src/game/hitbox';
import { createBallisticsSystem } from '../../../src/weapons/ballistics';
import { mapWorld } from '../sim-fixtures/worlds';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const STAND_EYE = 1.64;
const PLAYER_LIVES = 3;
const RESPAWN_SECONDS = 3;
const REGEN_DELAY = 5;
const REGEN_PER_SECOND = 18;
const DT = Number(process.env.SKIRMISH_DT ?? 1 / 120);
const BOTS = Number(process.env.SKIRMISH_BOTS ?? 8);
const DIFFICULTY = process.env.SKIRMISH_DIFFICULTY ?? 'veteran';
/** x,y,z: the player stands (and respawns) here instead of at the player spawns. */
const STAND = process.env.SKIRMISH_STAND?.split(',').map(Number);

interface Spawn {
  position: number[];
  yaw: number;
}
interface Meta {
  bounds: { min: number[]; max: number[] };
  spawns: { player: Spawn[]; enemy: Spawn[] };
  lighting: { fog: { density: number } };
}

class StandingPlayer implements Combatant {
  readonly kind = 'local' as const;
  readonly team = 'alpha' as const;
  readonly name = 'You';
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  readonly crouching = false;
  yaw = 0;
  health = 100;
  alive = true;
  sinceHurt = Infinity;
  constructor(
    readonly id: number,
    private readonly events: EventBus<GameEvents>,
  ) {}
  eyePosition(target: Vector3): Vector3 {
    return target.set(this.position.x, this.position.y + STAND_EYE, this.position.z);
  }
  hitTest(origin: Vector3, direction: Vector3, maxDistance: number): CombatantHit | null {
    return hitTestHumanoid(this.position, false, origin, direction, maxDistance);
  }
  applyDamage(info: DamageInfo): void {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - info.amount);
    this.sinceHurt = 0;
    if (this.health <= 0) {
      this.alive = false;
      this.events.emit('died', { victimId: this.id, killerId: info.attackerId, weaponId: info.weaponId, headshot: info.zone === 'head' });
    }
  }
  respawn(position: Vector3, yaw: number): void {
    this.position.copy(position);
    this.yaw = yaw;
    this.health = 100;
    this.alive = true;
    this.sinceHurt = Infinity;
    this.events.emit('spawned', { combatantId: this.id });
  }
  update(dt: number): void {
    this.sinceHurt += dt;
    if (this.alive && this.health < 100 && this.sinceHurt >= REGEN_DELAY) this.health = Math.min(100, this.health + REGEN_PER_SECOND * dt);
  }
}

/** The native port's renderer-free muzzle (IronvaleAI/Bot/Bot.swift muzzleWorld). */
function stubVisual(): SoldierVisual & { bot?: { position: Vector3; yaw: number } } {
  const root = new Object3D();
  let pitch = 0;
  return {
    root,
    muzzleWorld(target: Vector3): Vector3 {
      const yaw = root.rotation.y;
      const fx = -Math.sin(yaw) * Math.cos(pitch);
      const fy = Math.sin(pitch);
      const fz = -Math.cos(yaw) * Math.cos(pitch);
      const rx = Math.cos(yaw);
      const rz = -Math.sin(yaw);
      return target.set(
        root.position.x + fx * 0.62 + rx * 0.08,
        root.position.y + STAND_EYE + fy * 0.62 - 0.1,
        root.position.z + fz * 0.62 + rz * 0.08,
      );
    },
    setState(state) {
      pitch = state.aimPitch;
    },
    die() {},
    revive() {},
    flinch() {},
    update() {},
    dispose() {},
  };
}

interface Result {
  firstShot: Map<number, number>;
  shots: Map<number, number>;
  roles: Map<number, string>;
  deaths: number[];
  hits: number;
  end: number;
}

async function play(mapId: string, seed: number, seconds: number): Promise<Result> {
  const meta = JSON.parse(readFileSync(resolve(repoRoot, 'native/MapPackages', mapId, 'meta.json'), 'utf8')) as Meta;
  const world = mapWorld(repoRoot, mapId);
  const events = new EventBus<GameEvents>();
  const combat = new Combat(() => world);
  const frameHooks: (() => void)[] = [];
  const v = (a: number[]): Vector3 => new Vector3(a[0], a[1], a[2]);
  const map = {
    bounds: new Box3(v(meta.bounds.min), v(meta.bounds.max)),
    enemySpawns: meta.spawns.enemy.map((s) => ({ position: v(s.position), yaw: s.yaw })),
    playerSpawns: meta.spawns.player.map((s) => ({ position: v(s.position), yaw: s.yaw })),
    lighting: meta.lighting,
  };
  const player = new StandingPlayer(combat.allocateId(), events);
  const ctx = {
    events,
    world,
    combat,
    player,
    map,
    time: 0,
    assets: { preload: async () => {} },
    engine: { scene: { add() {}, remove() {} }, onFrame: (f: () => void) => frameHooks.push(f), camera: { position: new Vector3() } },
  } as Record<string, unknown>;
  ctx.ballistics = createBallisticsSystem(ctx as never, seededRandom(seed));
  const manager = new BotManager(ctx as never);
  // A different squad dice per seed, as two web matches differ.
  (manager as unknown as { random: () => number }).random = seededRandom(seed * 7919 + 1);
  (manager as unknown as { pool: Map<string, SoldierVisual[]> }).pool.set('bravo', Array.from({ length: 16 }, stubVisual));
  await manager.enterMap(map as never);

  combat.add(player);
  const spawnPlayer = (initial: boolean): void => {
    const enemies = combat.enemiesOf(player.team);
    let best = map.playerSpawns[0]!;
    let bestScore = -Infinity;
    for (const spawn of map.playerSpawns) {
      const nearest = enemies.reduce((min, e) => Math.min(min, e.position.distanceTo(spawn.position)), Infinity);
      if (nearest > bestScore) {
        bestScore = nearest;
        best = spawn;
      }
    }
    if (initial) best = map.playerSpawns[0]!;
    player.respawn(STAND ? v(STAND) : best.position, best.yaw);
  };
  spawnPlayer(true);
  manager.spawn(BOTS, 'bravo', DIFFICULTY as never);

  const result: Result = { firstShot: new Map(), shots: new Map(), roles: new Map(), deaths: [], hits: 0, end: seconds };
  for (const bot of manager.bots) result.roles.set(bot.id, bot.role);
  events.on('shotFired', (e) => {
    if (e.shooterId === player.id) return;
    if (!result.firstShot.has(e.shooterId)) result.firstShot.set(e.shooterId, ctx.time as number);
    result.shots.set(e.shooterId, (result.shots.get(e.shooterId) ?? 0) + 1);
  });
  events.on('combatantHit', (e) => {
    if (e.targetId === player.id) result.hits++;
  });
  events.on('died', (e) => {
    if (e.victimId === player.id) result.deaths.push(ctx.time as number);
  });

  let respawnTimer = 0;
  for (let t = 0; t < seconds; t += DT) {
    ctx.time = (ctx.time as number) + DT;
    player.update(DT);
    manager.update(DT);
    for (const hook of frameHooks) hook();
    if (!player.alive) {
      if (respawnTimer <= 0) respawnTimer = RESPAWN_SECONDS;
      respawnTimer -= DT;
      if (respawnTimer <= 0) {
        if (result.deaths.length >= PLAYER_LIVES && BOTS === 8) {
          result.end = ctx.time as number;
          break;
        }
        spawnPlayer(false);
      }
    }
  }
  manager.dispose();
  return result;
}

const outPath = resolve(repoRoot, 'native/Contract/nav/skirmish.json');
const check = process.env.NAV_FIXTURES_CHECK === '1';
/** Matches per map in the fixture; each a different squad dice and bullet dice. */
const FIXTURE_SEEDS = 16;
const FIXTURE_SECONDS = 90;
const round = (x: number): number => Math.round(x * 100) / 100;

it('plays the web skirmish headless', async () => {
  const seeds = Number(process.env.SKIRMISH_SEEDS ?? FIXTURE_SEEDS);
  const seconds = Number(process.env.SKIRMISH_SECONDS ?? FIXTURE_SECONDS);
  const maps = (process.env.SKIRMISH_MAPS ?? 'railyard,headworks').split(',');
  const fixture: Record<string, unknown> = {};
  for (const mapId of maps) {
    const fired: number[] = [];
    const firstShots: number[] = [];
    const ends: number[] = [];
    const hits: number[] = [];
    const rolesFired: Record<string, number> = {};
    for (let seed = 1; seed <= seeds; seed++) {
      const r = await play(mapId, seed, seconds);
      const ids = [...r.roles.keys()];
      const line = ids
        .map((id) => `${r.roles.get(id)}:${r.firstShot.has(id) ? `${r.firstShot.get(id)!.toFixed(1)}s/${r.shots.get(id)}` : '-'}`)
        .join(' ');
      fired.push(r.firstShot.size);
      firstShots.push(Math.min(...r.firstShot.values()));
      ends.push(r.end);
      hits.push(r.hits);
      for (const id of r.firstShot.keys()) rolesFired[r.roles.get(id)!] = (rolesFired[r.roles.get(id)!] ?? 0) + 1;
      console.log(`web skirmish ${mapId} seed ${seed}: ${r.firstShot.size}/8 fired, hits ${r.hits}, deaths ${r.deaths.map((d) => d.toFixed(1)).join(',')}, end ${r.end.toFixed(1)} s | ${line}`);
    }
    console.log(`web skirmish ${mapId}: bots that fired per match ${fired.join(',')} (mean ${(fired.reduce((a, b) => a + b, 0) / fired.length).toFixed(2)})`);
    fixture[mapId] = {
      matches: seeds,
      botsThatFired: { min: Math.min(...fired), max: Math.max(...fired), perMatch: fired },
      firstShotSeconds: { min: round(Math.min(...firstShots)), max: round(Math.max(...firstShots)) },
      endSeconds: { min: round(Math.min(...ends)), max: round(Math.max(...ends)) },
      hitsOnPlayer: { min: Math.min(...hits), max: Math.max(...hits) },
      /** Matches in which at least one soldier of each role fired. */
      rolesFired,
    };
  }
  if (['SKIRMISH_SEEDS', 'SKIRMISH_SECONDS', 'SKIRMISH_MAPS', 'SKIRMISH_DT', 'SKIRMISH_BOTS', 'SKIRMISH_DIFFICULTY', 'SKIRMISH_STAND'].some((k) => process.env[k])) return;
  const text = `${JSON.stringify({ bots: 8, difficulty: 'veteran', seconds, player: 'stands at the first player spawn, never fires', maps: fixture }, null, 1)}\n`;
  if (check) {
    expect(existsSync(outPath) && readFileSync(outPath, 'utf8') === text, 'native/Contract/nav/skirmish.json is out of date; run native/Tools/nav-fixtures/run.sh').toBe(true);
    return;
  }
  writeFileSync(outPath, text);
}, 600_000);
