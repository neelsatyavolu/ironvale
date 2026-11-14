/**
 * fx-fixtures (PLAN.md 7, M9 FX sub-lane): writes native/Contract/fx/ from the web sources.
 *   pure.json     RingPool / DirtyRange / scaledCount, tracer math, casing physics and roof-mask traces,
 *                 the quality tiers' particle and detail densities, the per-surface looks
 *   scenes.json   scripted event scenes run through the real src/fx modules (harness.ts): inputs,
 *                 and after every step the buffers each module writes for the GPU
 * With FX_FIXTURES_CHECK=1 it regenerates in memory and fails on any difference. Run ./run.sh [--check].
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vector3 } from 'three/webgpu';
import { expect, it } from 'vitest';
import { graphicsForTier } from '../../../src/core/settings';
import { seededRandom } from '../../../src/core/random';
import { CASING_TUNING, createCasingBody, reflectVelocity, stepCasing } from '../../../src/fx/casing-physics';
import { DirtyRange, RingPool, scaledCount } from '../../../src/fx/pool';
import { RoofMask } from '../../../src/fx/roof-mask';
import { SURFACE_LOOKS } from '../../../src/fx/surfaces';
import { showLocalTracer, tracerLength, visibleTracerSpeed } from '../../../src/fx/tracer-math';
import { BOX_INTERIOR, boxWorld, exportWorld } from '../sim-fixtures/worlds';
import { runScene, type FixtureEvent, type Scene, type SceneStep } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const outDir = resolve(repoRoot, 'native/Contract/fx');
const check = process.env.FX_FIXTURES_CHECK === '1';

function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort((item as Record<string, unknown>)[key])]));
    }
    return item;
  };
  const text = JSON.stringify(sort(value), null, 1);
  return `${text.replace(/\[[^[\]{}]*\]/g, (match) => match.replace(/\s+/g, ''))}\n`;
}

function pure(): unknown {
  const rand = seededRandom(0x5eed);
  const scaled: number[][] = [];
  for (const base of [0, 1, 3, 7, 24]) {
    for (const density of [-0.5, 0, 0.25, 0.5, 0.85, 1, 1.4]) {
      for (let k = 0; k < 4; k++) {
        const roll = rand();
        scaled.push([base, density, roll, scaledCount(base, density, roll)]);
      }
    }
  }
  const ring = new RingPool(5);
  const ringTrace: number[][] = [];
  for (let i = 0; i < 13; i++) {
    const peek = ring.peek(3);
    const wrapped = ring.wrapped ? 1 : 0;
    ringTrace.push([ring.next(), peek, wrapped]);
    if (i === 9) ring.reset();
  }
  const dirty = new DirtyRange();
  const dirtyTrace: (number[] | null)[] = [];
  for (const marks of [[], [4], [7, 2, 9], [3, 3]]) {
    for (const m of marks) dirty.mark(m);
    let got: number[] | null = null;
    dirty.flush((s, c) => (got = [s, c]));
    dirtyTrace.push(got);
  }
  const tracer: number[][] = [];
  for (const velocity of [360, 400, 850, 900]) {
    for (const distance of [0.5, 2, 5, 12, 30, 80, 300]) {
      const speed = visibleTracerSpeed(velocity, distance);
      tracer.push([velocity, distance, speed, tracerLength(speed, distance)]);
    }
  }
  const showTracer: number[][] = [];
  for (const pellets of [1, 9]) for (let i = 0; i < 10; i++) showTracer.push([pellets, i, showLocalTracer(i, pellets) ? 1 : 0]);

  const world = boxWorld();
  const probe = (o: Vector3, d: Vector3, max: number) => world.raycast(o, d, max);
  const casing: unknown[] = [];
  const starts: [number[], number[]][] = [
    [[0.5, 1.4, 0.3], [1.8, 1.6, 0.4]],
    [[0, 1.5, -6], [0, 0.5, -4.5]],
    [[-6, 2, -2], [0.3, -1, 0.2]],
    [[0, 1.2, 6], [0.5, 2.5, 0.1]],
  ];
  for (const [p, v] of starts) {
    const body = createCasingBody();
    body.position.set(p[0]!, p[1]!, p[2]!);
    body.velocity.set(v[0]!, v[1]!, v[2]!);
    const trace: unknown[] = [];
    for (let f = 0; f < 200; f++) {
      const result = stepCasing(body, 1 / 60, probe, 0.0054, CASING_TUNING);
      trace.push([result, ...body.position.toArray(), ...body.velocity.toArray(), body.bounces, body.surface ?? '']);
    }
    casing.push({ start: [p, v], trace });
  }
  const reflect = [
    [[1, -2, 0.5], [0, 1, 0]],
    [[1, 2, 0.5], [0, 1, 0]],
    [[-3, 0.2, 1], [0.6, 0.8, 0]],
  ].map(([v, n]) => [v, n, reflectVelocity(new Vector3(...v!), new Vector3(...n!), 0.38, 0.45, new Vector3()).toArray()]);

  const mask = new RoofMask(32, 1);
  const zone = { min: BOX_INTERIOR.min, max: BOX_INTERIOR.max };
  const top = world.bounds.max.y + 1;
  const bottom = world.bounds.min.y - 1;
  const heightProbe = (x: number, z: number): number => {
    let h = world.groundHeight(x, z, top, top - bottom) ?? -1000;
    if (x >= zone.min[0]! && x <= zone.max[0]! && z >= zone.min[2]! && z <= zone.max[2]!) h = Math.max(h, zone.max[1]!);
    return h;
  };
  const maskTrace: unknown[] = [];
  const path = [[0, 0], [0.4, 0.2], [3.7, -1.2], [3.9, -1.1], [20.5, 6.2], [-40, 33]];
  for (const [x, z] of path) {
    mask.setCentre(x!, z!);
    const stale = mask.stale;
    const done = mask.refresh(heightProbe, stale > 512 ? Infinity : 48);
    const samples = [-3, 0.5, 7.2].flatMap((dx) => [-2, 1.5].map((dz) => mask.heightAt(x! + dx, z! + dz)));
    maskTrace.push({ centre: [x, z], stale, done, version: mask.version, heights: Array.from(mask.heights), samples });
  }

  const tiers = Object.fromEntries(
    (['low', 'medium', 'high', 'ultra'] as const).map((t) => [t, [graphicsForTier(t).particleDensity, graphicsForTier(t).detailDensity]]),
  );
  return { scaled, ringTrace, dirtyTrace, tracer, showTracer, casing, reflect, casingTuning: CASING_TUNING, mask: maskTrace, tiers, surfaces: SURFACE_LOOKS };
}

const LIGHTING = { sunDirection: [0.42, 0.78, -0.46] as [number, number, number], sunColor: 0xffe2c0, sunIntensity: 2.6, skyIntensity: 0.9, fogColor: 0x8a9099 };
const POSE = { eye: [0, 1.6, 2] as [number, number, number], yaw: 0, pitch: -0.05 };
const SURFACES = ['concrete', 'plaster', 'asphalt', 'cobble', 'metal', 'wood', 'dirt', 'gravel', 'sand', 'grass', 'water', 'glass', 'foliage', 'flesh'] as const;
const steps = (n: number, dt: number): SceneStep[] => Array.from({ length: n }, () => ({ dt, events: [] }));

function scenes(): Scene[] {
  const base = { seed: 0x1234, weather: 'clear' as const, particleDensity: 1, detailDensity: 0.85, lighting: LIGHTING, pose: POSE, feet: [0, 0, 2] as [number, number, number], interiors: [BOX_INTERIOR as never] };
  const impacts: FixtureEvent[] = SURFACES.map((surface, i) => ({ type: 'bulletImpact', surface, a: [-6 + i, 1 + (i % 3) * 0.5, -7.8], normal: [0, 0, 1] }));
  const far: FixtureEvent[] = [40, 90, 150, 200].map((d) => ({ type: 'bulletImpact', surface: 'concrete', a: [0, 0, 2 - d], normal: [0, 1, 0] }));
  const pellets: FixtureEvent[] = [0, 1, 2].map((i) => ({ type: 'bulletImpact', weapon: { id: 'm4a1', pellets: 9 }, surface: 'dirt', a: [i, 0, -3], normal: [0, 1, 0] }));
  const gunfire: SceneStep[] = [
    {
      dt: 1 / 60,
      events: [
        { type: 'shotFired', weapon: { id: 'm4a1' }, local: true, a: [0.2, 1.45, 1.4], b: [0, 0, -1] },
        { type: 'bulletTrace', weapon: { id: 'm4a1' }, local: true, a: [0.2, 1.45, 1.4], b: [0, 1.2, -7.8] },
        { type: 'casingEjected', kind: 'rifle', a: [0.3, 1.45, 1.6], b: [2, 1.5, 0.3] },
        { type: 'shotFired', weapon: { id: 'mp5' }, a: [5, 1.5, -4], b: [-0.6, 0, 0.8] },
        { type: 'bulletTrace', weapon: { id: 'mp5' }, a: [5, 1.5, -4], b: [-1, 1.2, 4] },
        { type: 'nearMiss', a: [0.4, 1.6, 2], b: [-0.6, 0, 0.8] },
        { type: 'shotFired', weapon: { id: 'm24' }, a: [0, 1.5, -90], b: [0, 0, 1] },
        { type: 'shotFired', weapon: { id: 'm249' }, a: [-4, 1.5, -6], b: [0.5, 0, 0.86] },
        { type: 'bulletTrace', weapon: { id: 'm249' }, a: [-4, 1.5, -6], b: [-4.2, 1.5, -6.6] },
        { type: 'casingEjected', kind: 'pistol', a: [-6, 1.5, -2], b: [0.2, 0.3, 0.1] },
        { type: 'casingEjected', kind: 'shotgun', a: [0, 2.2, 6], b: [0.6, 1.5, 0.2] },
      ],
    },
  ];
  for (let i = 0; i < 12; i++) {
    gunfire.push({
      dt: 1 / 60,
      events:
        i % 3 === 0
          ? [
              { type: 'shotFired', weapon: { id: 'scarh' }, local: true, a: [0.2, 1.45, 1.4], b: [0.02, 0.01, -1] },
              { type: 'bulletTrace', weapon: { id: 'scarh' }, local: true, a: [0.2, 1.45, 1.4], b: [0.3, 1.5, -7.8] },
              { type: 'bulletTrace', weapon: { id: 'scarh', pellets: 9 }, local: true, a: [0.2, 1.45, 1.4], b: [0.3, 1.5, -7.8] },
            ]
          : [],
    });
  }
  gunfire.push(...steps(150, 1 / 30), ...steps(40, 0.5));
  const blood: SceneStep[] = [
    {
      dt: 1 / 60,
      events: [
        { type: 'combatantHit', a: [1, 1.4, -4], b: [0, 0, -1] },
        { type: 'combatantHit', a: [1, 1.4, -4], b: [0, 0, 0], fatal: true },
        { type: 'combatantHit', a: [0, 1.4, 1], b: [0, 0, 1], targetId: 0 },
        { type: 'combatantHit', a: [0, 1.4, -120], b: [0, 0, 1] },
      ],
    },
    ...steps(5, 0.1),
  ];
  const grenade: SceneStep[] = [
    { dt: 1 / 60, events: [{ type: 'grenadeExploded', a: [2, 0.1, -3] }] },
    { dt: 1 / 60, events: [{ type: 'grenadeExploded', a: [0, 0.1, -150] }] },
    ...steps(40, 1 / 60),
  ];
  const wrap: SceneStep[] = Array.from({ length: 30 }, (_, f) => ({
    dt: 1 / 60,
    events: Array.from({ length: 9 }, (_, i) => ({ type: 'bulletImpact' as const, surface: SURFACES[(f + i) % 10]!, a: [((f * 9 + i) % 24) * 0.5 - 6, 0.6 + (i % 4) * 0.5, -7.8] as [number, number, number], normal: [0, 0, 1] as [number, number, number] })),
  }));
  // Aiming a grenade: still, then turning (the ribbon is rebuilt when the throw or the eye moves), then put away.
  const aim: SceneStep[] = [
    ...Array.from({ length: 4 }, () => ({ dt: 1 / 60, events: [], aim: { origin: [0.3, 1.4, 1.6] as [number, number, number], velocity: [0, 6, -12] as [number, number, number] } })),
    ...Array.from({ length: 6 }, (_, i) => ({
      dt: 1 / 60,
      events: [],
      pose: { eye: [0, 1.6, 2] as [number, number, number], yaw: i * 0.08, pitch: 0.1 },
      aim: { origin: [0.3, 1.4, 1.6] as [number, number, number], velocity: [-Math.sin(i * 0.08) * 12, 5 + i, -Math.cos(i * 0.08) * 12] as [number, number, number] },
    })),
    { dt: 1 / 60, events: [], aim: { origin: [0, 1.4, -4.5], velocity: [0, 1, -0.5] } },
    { dt: 1 / 60, events: [] },
  ];
  const walk: SceneStep[] = Array.from({ length: 90 }, (_, f) => ({ dt: 1 / 60, events: [], feet: [f * 0.12, 0, 2 + f * 0.05] as [number, number, number], indoors: f > 40 && f < 60 }));
  return [
    { ...base, name: 'impacts', steps: [{ dt: 1 / 60, events: [...impacts, ...far, ...pellets] }, ...steps(4, 0.1)] },
    { ...base, name: 'impacts-rain-half', weather: 'rain', particleDensity: 0.5, seed: 77, steps: [{ dt: 1 / 60, events: impacts }, ...steps(4, 0.1)] },
    { ...base, name: 'gunfire', steps: gunfire },
    { ...base, name: 'gunfire-low', particleDensity: 0.5, detailDensity: 0.35, seed: 9, steps: gunfire.slice(0, 40) },
    { ...base, name: 'blood', steps: blood },
    { ...base, name: 'grenade', steps: grenade },
    { ...base, name: 'pool-wrap', steps: wrap },
    { ...base, name: 'grenade-aim', steps: aim },
    { ...base, name: 'rain', weather: 'rain', steps: [{ dt: 0, events: [] }, ...walk] },
    { ...base, name: 'clear-motes', steps: [{ dt: 0, events: [] }, ...walk.slice(0, 20)] },
    { ...base, name: 'mist', weather: 'mist', steps: [{ dt: 0, events: [] }, ...walk.slice(0, 50)] },
  ];
}

it('exports the fx fixtures', () => {
  const world = boxWorld();
  const outputs: Record<string, string> = {};
  outputs['pure.json'] = canonical(pure());
  outputs['scenes.json'] = canonical({
    world: { ...exportWorld(world), interiors: [BOX_INTERIOR] },
    scenes: scenes().map((scene) => ({ scene, result: runScene(scene, world) })),
  });
  if (!check) mkdirSync(outDir, { recursive: true });
  for (const [name, text] of Object.entries(outputs)) {
    const file = resolve(outDir, name);
    if (check) {
      expect(existsSync(file), `${file} missing; run native/Tools/fx-fixtures/run.sh`).toBe(true);
      expect(readFileSync(file, 'utf8') === text, `${name} differs from what src/ produces; rerun run.sh`).toBe(true);
    } else {
      writeFileSync(file, text);
    }
  }
});
