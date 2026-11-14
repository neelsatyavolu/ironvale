/**
 * dynres fixture (M9post, PLAN.md 7): drives the web's DynamicResolution (src/render/dynamic-resolution.ts)
 * through seeded frame-time traces (GPU-bound, CPU-bound, hitches, load going away) and writes
 * native/Tools/m3-parity/fixtures/dynamic-resolution.json: every frame's dt and the controller's scale
 * after it. IronvaleRenderTests/DynamicResolutionTests replays the traces against the Swift port.
 * With DYNRES_CHECK=1 it regenerates in memory and fails on any difference.
 * Run: npx vitest run --config native/Tools/vitest.config.ts native/Tools/m3-parity/dynres.test.ts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { seededRandom } from '../../../src/core/random';
import { DynamicResolution } from '../../../src/render/dynamic-resolution';

const out = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/dynamic-resolution.json');
const BUDGET = 1 / 60;
const FLOOR = Math.min(1, 0.5 / 0.85);

type Cost = (scale: number, t: number, random: () => number) => number;
const scenarios: Record<string, { seconds: number; cost: Cost }> = {
  gpuBound: { seconds: 120, cost: (s, _t, r) => BUDGET * (0.9 + 0.3 * r()) * s * s * 1.6 },
  cpuBound: { seconds: 120, cost: (_s, _t, r) => BUDGET * (1.25 + 0.2 * r()) },
  loadGoesAway: { seconds: 150, cost: (s, t, r) => (t < 40 ? BUDGET * 1.7 * s * s : BUDGET * 0.4) * (0.95 + 0.1 * r()) },
  hitches: { seconds: 90, cost: (s, _t, r) => (r() < 0.02 ? 0.3 + r() : BUDGET * (0.8 + 0.5 * r()) * s) },
  vsynced: {
    seconds: 200,
    cost: (s, _t, r) => Math.max(1, Math.ceil((BUDGET * 1.05 * s * s * (0.97 + 0.06 * r())) / BUDGET - 1e-9)) * BUDGET,
  },
};

function trace(name: string, seconds: number, cost: Cost) {
  const random = seededRandom(name.length * 7919 + 13);
  const controller = new DynamicResolution();
  const dt: number[] = [];
  const scale: number[] = [];
  let elapsed = 0;
  while (elapsed < seconds) {
    const d = cost(controller.scale, elapsed, random);
    elapsed += d;
    controller.update(d, BUDGET, FLOOR);
    dt.push(d);
    scale.push(controller.scale);
  }
  return { dt, scale };
}

it('writes the dynamic-resolution traces', () => {
  const fixture = {
    source: 'src/render/dynamic-resolution.ts',
    budget: BUDGET,
    floor: FLOOR,
    traces: Object.fromEntries(Object.entries(scenarios).map(([name, s]) => [name, trace(name, s.seconds, s.cost)])),
  };
  const text = JSON.stringify(fixture) + '\n';
  if (process.env.DYNRES_CHECK === '1') {
    expect(existsSync(out) ? readFileSync(out, 'utf8') : '').toBe(text);
  } else {
    writeFileSync(out, text);
  }
  const distinct = new Set(Object.values(fixture.traces).flatMap((t) => t.scale));
  expect(distinct.size).toBeGreaterThan(4);
});
