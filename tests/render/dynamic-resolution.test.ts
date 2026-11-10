import { describe, expect, it } from 'vitest';
import { DynamicResolution, RESOLUTION_STEP } from '../../src/render/dynamic-resolution';

const BUDGET = 1 / 60;
const FLOOR = 0.6;

/** Run `seconds` of frames whose interval comes from `frameTime(scale)`; returns the scales seen after each change. */
function run(controller: DynamicResolution, seconds: number, frameTime: (scale: number) => number, budget = BUDGET): number[] {
  const changes: number[] = [];
  let elapsed = 0;
  while (elapsed < seconds) {
    const dt = frameTime(controller.scale);
    elapsed += dt;
    if (controller.update(dt, budget, FLOOR)) changes.push(controller.scale);
  }
  return changes;
}

/** A 60 Hz display: a frame takes a whole number of refresh intervals. */
const vsynced = (cost: (scale: number) => number) => (scale: number) => Math.max(1, Math.ceil(cost(scale) / BUDGET - 1e-9)) * BUDGET;

describe('DynamicResolution', () => {
  it('leaves the scale alone when frames are on budget', () => {
    const controller = new DynamicResolution();
    expect(run(controller, 60, () => BUDGET)).toEqual([]);
    expect(controller.scale).toBe(1);
  });

  it('steps down while frames run long and stops once they fit', () => {
    const controller = new DynamicResolution();
    // GPU-bound: cost grows with pixel count and fits the budget at 0.85 and below.
    const cost = (scale: number) => (BUDGET * 0.98 * scale * scale) / (0.85 * 0.85);
    // 15 s: after the first failed probe has been undone and before the next one.
    run(controller, 15, vsynced(cost));
    expect(controller.scale).toBeLessThanOrEqual(0.85 + 1e-9);
    expect(controller.scale).toBeGreaterThanOrEqual(0.8 - 1e-9);
  });

  it('recovers the scale on a vsynced display once the load goes away', () => {
    const controller = new DynamicResolution();
    run(controller, 20, vsynced((scale) => BUDGET * 1.6 * scale * scale));
    expect(controller.scale).toBeLessThan(0.85);
    // Frame intervals are now exactly the refresh interval, never shorter.
    run(controller, 60, vsynced(() => BUDGET * 0.3));
    expect(controller.scale).toBe(1);
  });

  it('does not bounce when one step up is too much', () => {
    const controller = new DynamicResolution();
    const cost = (scale: number) => (BUDGET * 0.98 * scale * scale) / (0.85 * 0.85);
    run(controller, 30, vsynced(cost));
    const settled = controller.scale;
    const changes = run(controller, 300, vsynced(cost));
    // Probes back off (4.5 s, 9 s, 18 s, ...), so five minutes holds only a handful of them.
    expect(changes.length).toBeLessThanOrEqual(14);
    expect(controller.scale).toBeCloseTo(settled, 5);
    const last = run(controller, 60, vsynced(cost));
    expect(last.length).toBeLessThanOrEqual(2);
  });

  it('gives the pixels back when lowering the scale does not help', () => {
    const controller = new DynamicResolution();
    // CPU-bound: every frame takes two refresh intervals whatever the scale.
    const changes = run(controller, 40, () => BUDGET * 2);
    expect(Math.min(...changes)).toBeCloseTo(FLOOR, 5);
    expect(controller.scale).toBe(1);
  });

  it('gives the pixels back when the target is above the display rate', () => {
    const controller = new DynamicResolution();
    run(controller, 40, () => 1 / 60, 1 / 120);
    expect(controller.scale).toBe(1);
  });

  it('stays at the floor when the floor is still better than full scale', () => {
    const controller = new DynamicResolution();
    run(controller, 40, (scale) => BUDGET * 3 * scale * scale);
    expect(controller.scale).toBeCloseTo(FLOOR, 5);
  });

  it('ignores hitches', () => {
    const controller = new DynamicResolution();
    for (let i = 0; i < 20; i++) controller.update(0.8, BUDGET, FLOOR);
    expect(controller.scale).toBe(1);
  });

  it('moves one step at a time and never leaves [floor, 1]', () => {
    const controller = new DynamicResolution();
    let previous = controller.scale;
    let slow = true;
    for (let i = 0; i < 40000; i++) {
      if (i % 900 === 0) slow = !slow;
      if (controller.update(slow ? BUDGET * 2 : BUDGET, BUDGET, FLOOR)) {
        const restored = controller.scale === 1 && previous < 1 - RESOLUTION_STEP - 1e-9;
        if (!restored) expect(Math.abs(controller.scale - previous)).toBeCloseTo(RESOLUTION_STEP, 5);
        previous = controller.scale;
      }
      expect(controller.scale).toBeGreaterThanOrEqual(FLOOR - 1e-9);
      expect(controller.scale).toBeLessThanOrEqual(1);
    }
  });

  it('reset returns to full scale', () => {
    const controller = new DynamicResolution();
    run(controller, 10, () => BUDGET * 2);
    controller.reset();
    expect(controller.scale).toBe(1);
  });
});
