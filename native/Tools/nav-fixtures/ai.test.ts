/**
 * ai-fixtures (M7b, PLAN.md 7): runs the web's bot logic (src/ai) on scripted and seeded inputs and
 * writes native/Contract/nav/ai.json, which IronvaleAITests replays against the Swift port:
 *  - pure rules: assignRoles, botName, orderSpawns + assignSpawns, inViewCone, effectiveVisionRange,
 *    inVisionCone, hearingRadius, aimErrorDegrees, readyToFire, botShotSpread, scaledWeapon damage;
 *  - AimModel traces per difficulty and BotWeapon traces per role and difficulty (mulberry32 random);
 *  - per map: PathQueue requests between seeded node pairs (with and without an avoid area) run at
 *    BotManager's 350-unit budget, recording when each finished, its status and every corner point;
 *    findCover queries and coverAgainst masks on seeded nodes.
 * With NAV_FIXTURES_CHECK=1 it regenerates in memory and fails on any difference. Run ./run.sh [--check].
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Box3, Vector3 } from 'three/webgpu';
import { expect, it } from 'vitest';
import { AimModel, aimErrorDegrees } from '../../../src/ai/aim';
import { BotWeapon } from '../../../src/ai/botweapon';
import { coverAgainst, findCover } from '../../../src/ai/cover';
import { DIFFICULTY, DIFFICULTY_ORDER, scaledWeapon } from '../../../src/ai/difficulty';
import { botShotSpread, readyToFire } from '../../../src/ai/marksman';
import { buildNavGrid, type NavGrid } from '../../../src/ai/navgrid';
import { PathHandle, PathQueue } from '../../../src/ai/pathfinder';
import { effectiveVisionRange, hearingRadius, inVisionCone, type NoiseKind } from '../../../src/ai/perception';
import { assignRoles, botName, ROLES, type BotRole } from '../../../src/ai/roles';
import { assignSpawns, inViewCone, orderSpawns } from '../../../src/ai/spawn';
import { hashString, seededRandom } from '../../../src/core/random';
import { WEAPON_DEFS } from '../../../src/weapons/defs';
import { mapWorld } from '../sim-fixtures/worlds';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const outFile = resolve(repoRoot, 'native/Contract/nav/ai.json');
const check = process.env.NAV_FIXTURES_CHECK === '1';
const MAPS = ['range', 'railyard', 'headworks', 'harbor'];
/** BotManager's per-frame path budget (src/ai/manager.ts PATH_BUDGET). */
const PATH_BUDGET = 350;
const ROLE_IDS = Object.keys(ROLES) as BotRole[];

interface Meta {
  bounds: { min: number[]; max: number[] };
  spawns: { player: { position: number[] }[]; enemy: { position: number[] }[] };
}


function pureRules(): Record<string, unknown> {
  const rand = seededRandom(hashString('ai-fixtures-pure'));
  const roles = Array.from({ length: 34 }, (_, count) => assignRoles(count));
  const names = Array.from({ length: 60 }, (_, i) => botName(i));

  const spawnCases = Array.from({ length: 40 }, () => {
    const n = Math.floor(rand() * 9);
    const spawns = Array.from({ length: n }, () => [rand() * 80 - 40, rand() * 4, rand() * 80 - 40]);
    const player = [rand() * 80 - 40, 0, rand() * 80 - 40];
    const seen = spawns.map(() => rand() < 0.4);
    const count = Math.floor(rand() * 14);
    const capacity = 1 + Math.floor(rand() * 4);
    const order = orderSpawns(
      spawns.map((p) => ({ position: new Vector3(p[0], p[1], p[2]), yaw: 0 })),
      new Vector3(player[0], player[1], player[2]),
      (i) => seen[i] ?? false,
    );
    return { spawns, player, seen, count, capacity, indices: order.indices, hidden: order.hidden, picks: assignSpawns(count, order, capacity) };
  });
  // A tie in distance must keep the earlier spawn first (Array.prototype.sort is stable).
  {
    const spawns = [[10, 0, 0], [-10, 0, 0], [0, 0, 10], [0, 0, -10], [5, 0, 5]];
    const seen = [false, false, true, false, true];
    const order = orderSpawns(spawns.map((p) => ({ position: new Vector3(p[0], p[1], p[2]), yaw: 0 })), new Vector3(), (i) => seen[i] ?? false);
    spawnCases.push({ spawns, player: [0, 0, 0], seen, count: 9, capacity: 2, indices: order.indices, hidden: order.hidden, picks: assignSpawns(9, order, 2) });
  }

  const viewCone = Array.from({ length: 60 }, () => {
    const player = [rand() * 20 - 10, 0, rand() * 20 - 10];
    const point = [rand() * 20 - 10, rand(), rand() * 20 - 10];
    const yaw = rand() * 8 - 4;
    const half = rand() * 1.6;
    return { player, point, yaw, half, inView: inViewCone(new Vector3(...player), yaw, new Vector3(...point), half) };
  });

  const visionRange: unknown[] = [];
  for (const base of [40, 70, 140]) {
    for (const fog of [0, 0.004, 0.006, 0.012, 0.03]) {
      for (const crouching of [false, true]) {
        for (const speed of [0, 0.4, 2, 5.6, 7]) {
          visionRange.push({ base, fog, crouching, speed, range: effectiveVisionRange(base, fog, crouching, speed) });
        }
      }
    }
  }
  const visionCone = Array.from({ length: 60 }, () => {
    const eye = [rand() * 20 - 10, 1.6, rand() * 20 - 10];
    const target = [rand() * 20 - 10, rand() * 3, rand() * 20 - 10];
    const yaw = rand() * 8 - 4;
    const half = rand() * 1.6;
    const range = rand() * 15;
    return { eye, target, yaw, half, range, inView: inVisionCone(eye[0]!, eye[1]!, eye[2]!, yaw, target[0]!, target[1]!, target[2]!, half, range) };
  });
  const hearing: unknown[] = [];
  for (const kind of ['shot', 'footstep', 'impact', 'nearMiss'] as NoiseKind[]) {
    for (const loudness of [0.6, 1, 1.4]) {
      for (const scale of [0.8, 1, 1.25]) hearing.push({ kind, loudness, scale, radius: hearingRadius(kind, loudness, scale) });
    }
  }
  const aimError = [0, 0.1, 0.25, 0.5, 1, 2.5].map((m) => ({ metres: m, degrees: aimErrorDegrees(m) }));
  const marksman: unknown[] = [];
  for (const weapon of ['m24', 'm4a1'] as const) {
    const def = WEAPON_DEFS[weapon];
    for (const sighted of [0, 0.3, 0.6, 0.9]) {
      for (const reaction of [0.2, 0.45]) marksman.push({ weapon, kind: 'ready', sighted, reaction, ready: readyToFire(def, sighted, reaction) });
    }
    for (const aim of [0.2, 1, 3]) {
      for (const distance of [5, 30]) {
        marksman.push({ weapon, kind: 'spread', aim, distance, minRange: 25, spread: botShotSpread(def, aim, distance, 25) });
      }
    }
  }
  const scaled: unknown[] = [];
  for (const weapon of Object.keys(WEAPON_DEFS) as (keyof typeof WEAPON_DEFS)[]) {
    for (const difficulty of DIFFICULTY_ORDER) scaled.push({ weapon, difficulty, damage: scaledWeapon(WEAPON_DEFS[weapon], difficulty).damage });
  }
  return { roles, names, spawnCases, viewCone, visionRange, visionCone, hearing, aimError, marksman, scaled };
}

function traces(): Record<string, unknown> {
  const aim = DIFFICULTY_ORDER.map((difficulty) => {
    const model = new AimModel(DIFFICULTY[difficulty]);
    const rand = seededRandom(hashString(`aim-${difficulty}`));
    const steps: unknown[] = [];
    for (let i = 0; i < 120; i++) {
      const dt = 1 / 60 + rand() * 0.02;
      const tracking = rand() < 0.7;
      const op = rand();
      const disturb = op < 0.05 ? rand() * 3 : 0;
      if (op > 0.97) model.reset();
      if (disturb > 0) model.disturb(disturb);
      model.update(dt, tracking);
      const angular = rand() * 30;
      const moving = rand() < 0.3;
      steps.push({ dt, tracking, disturb, reset: op > 0.97, angular, moving, spread: model.spread(angular, moving) });
    }
    return { difficulty, steps };
  });
  const weapons = ROLE_IDS.flatMap((role) =>
    DIFFICULTY_ORDER.map((difficulty) => {
      const def = scaledWeapon(WEAPON_DEFS[ROLES[role].weapon], difficulty);
      const seed = hashString(`botweapon-${role}-${difficulty}`);
      const weapon = new BotWeapon(def, ROLES[role], seededRandom(seed));
      const script = seededRandom(seed ^ 0x5bd1e995);
      const steps: unknown[] = [];
      for (let i = 0; i < 600; i++) {
        const dt = 1 / 120 + script() * (1 / 30);
        const trigger = script() < 0.8;
        if (script() < 0.004) weapon.startReload();
        const fired = weapon.update(dt, trigger);
        steps.push([dt, trigger ? 1 : 0, fired ? 1 : 0, weapon.magazine, weapon.reloading ? 1 : 0, weapon.reloadStarted ? 1 : 0, weapon.reloadFinished ? 1 : 0]);
      }
      return { role, difficulty, seed, steps };
    }),
  );
  return { aim, weapons };
}

function linkedNodes(grid: NavGrid, rand: () => number, n: number): number[] {
  const out: number[] = [];
  while (out.length < n) {
    const node = Math.floor(rand() * grid.nodeCount);
    if (grid.edges[node] !== 0) out.push(node);
  }
  return out;
}

function mapCases(mapId: string): Record<string, unknown> {
  const meta = JSON.parse(readFileSync(resolve(repoRoot, 'native/MapPackages', mapId, 'meta.json'), 'utf8')) as Meta;
  const world = mapWorld(repoRoot, mapId);
  const bounds = new Box3(new Vector3(...meta.bounds.min), new Vector3(...meta.bounds.max));
  const seeds = [...meta.spawns.enemy, ...meta.spawns.player].map((s) => new Vector3(...s.position));
  const builder = buildNavGrid(world, bounds, seeds);
  let step = builder.next();
  while (!step.done) step = builder.next();
  const grid = step.value;
  const rand = seededRandom(hashString(`ai-fixtures-${mapId}`));

  // Paths: every request queued at once, like a squad asking in one frame.
  const pairs = Array.from({ length: 24 }, (_, i) => {
    const [a, b] = linkedNodes(grid, rand, 2) as [number, number];
    const jitter = (): number => (rand() - 0.5) * 0.5;
    const start = [grid.nodeX(a) + jitter(), (grid.nodeY[a] ?? 0) + 0.02, grid.nodeZ(a) + jitter()];
    const goal = [grid.nodeX(b) + jitter(), grid.nodeY[b] ?? 0, grid.nodeZ(b) + jitter()];
    const avoid =
      i % 3 === 2
        ? { x: (start[0]! + goal[0]!) / 2, z: (start[2]! + goal[2]!) / 2, radius: 4 + rand() * 6, cost: 2 + rand() * 6 }
        : undefined;
    return { start, goal, avoid };
  });
  // One request off the grid entirely: must fail.
  pairs.push({ start: [1e4, 0, 1e4], goal: pairs[0]!.goal, avoid: undefined });
  const queue = new PathQueue(grid);
  const handles = pairs.map(() => new PathHandle());
  pairs.forEach((p, i) => queue.request(handles[i]!, p.start[0]!, p.start[1]!, p.start[2]!, p.goal[0]!, p.goal[1]!, p.goal[2]!, p.avoid));
  const doneAt = handles.map(() => -1);
  for (let frame = 0; frame < 5000 && doneAt.includes(-1); frame++) {
    queue.update(PATH_BUDGET);
    handles.forEach((h, i) => {
      if (doneAt[i] === -1 && (h.status === 'ready' || h.status === 'failed')) doneAt[i] = frame;
    });
  }
  const paths = pairs.map((p, i) => {
    const h = handles[i]!;
    return { ...p, status: h.status, doneAt: doneAt[i], count: h.count, partial: h.partial, points: Array.from(h.points.slice(0, h.count * 3)) };
  });

  const cover = linkedNodes(grid, rand, 40).map((node, i) => {
    const angle = rand() * Math.PI * 2;
    const far = 6 + rand() * 40;
    const query = {
      x: grid.nodeX(node) + (rand() - 0.5) * 0.6,
      y: grid.nodeY[node] ?? 0,
      z: grid.nodeZ(node) + (rand() - 0.5) * 0.6,
      threatX: grid.nodeX(node) + Math.sin(angle) * far,
      threatZ: grid.nodeZ(node) + Math.cos(angle) * far,
      radius: [8, 10, 12, 18][i % 4]!,
      minThreatDistance: i % 2 === 0 ? 4 : undefined,
      idealThreatDistance: i % 5 === 0 ? 20 : undefined,
      exclude: i % 3 === 0 ? node : undefined,
      taken: i % 4 === 1 ? linkedNodes(grid, rand, 3) : undefined,
      skip: i % 6 === 5 ? linkedNodes(grid, rand, 2) : undefined,
    };
    const found = findCover(grid, query);
    // A second pass with the found cell skipped, as the tactics do after a failed peek.
    const again = found >= 0 ? findCover(grid, { ...query, skip: [...(query.skip ?? []), found] }) : -1;
    return { query, found, again };
  });
  const against = linkedNodes(grid, rand, 200).map((node) => {
    const tx = grid.nodeX(node) + (rand() - 0.5) * 60;
    const tz = grid.nodeZ(node) + (rand() - 0.5) * 60;
    return [node, tx, tz, coverAgainst(grid, node, tx, tz)];
  });
  return { map: mapId, paths, cover, against };
}

it('exports the bot logic fixtures', () => {
  const fixture = { pure: pureRules(), traces: traces(), maps: MAPS.map(mapCases) };
  const text = `${JSON.stringify(fixture)}\n`;
  if (check) {
    expect(existsSync(outFile) && readFileSync(outFile, 'utf8') === text, 'native/Contract/nav/ai.json is out of date; run native/Tools/nav-fixtures/run.sh').toBe(true);
    return;
  }
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, text);
}, 600_000);
