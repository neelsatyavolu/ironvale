import { describe, expect, it } from 'vitest';
import { RoofMask, STALE_HEIGHT } from '../../src/fx/roof-mask';

/** Ground at y = 0 everywhere, with a roof whose top is at y = 4 over x in [10, 20), z in [0, 6). */
const shed = (x: number, z: number): number => (x >= 10 && x < 20 && z >= 0 && z < 6 ? 4 : 0);

function filled(size = 16, cell = 1, x = 0, z = 0): RoofMask {
  const mask = new RoofMask(size, cell);
  mask.setCentre(x, z);
  mask.refresh(shed, Infinity);
  return mask;
}

describe('RoofMask', () => {
  it('treats every cell as covered until it has been probed', () => {
    const mask = new RoofMask(8, 1);
    mask.setCentre(0, 0);
    expect(mask.stale).toBe(64);
    expect(mask.heightAt(0.5, 0.5)).toBe(STALE_HEIGHT);
    expect(mask.isCovered(0.5, 1, 0.5)).toBe(true);
  });

  it('hides rain below a roof and shows it in the open and above the roof', () => {
    const mask = filled(32, 1, 12, 3);
    expect(mask.stale).toBe(0);
    expect(mask.isCovered(15, 1.6, 3)).toBe(true);
    expect(mask.isCovered(15, 6, 3)).toBe(false);
    expect(mask.isCovered(5, 1.6, 3)).toBe(false);
    expect(mask.isCovered(15, 1.6, 8)).toBe(false);
    expect(mask.isCovered(5, -0.5, 3)).toBe(true);
  });

  it('probes at most the budget per refresh and finishes over several calls', () => {
    const mask = new RoofMask(8, 1);
    mask.setCentre(0, 0);
    let calls = 0;
    const counting = (x: number, z: number) => {
      calls++;
      return shed(x, z);
    };
    expect(mask.refresh(counting, 10)).toBe(10);
    expect(calls).toBe(10);
    expect(mask.stale).toBe(54);
    while (mask.stale > 0) mask.refresh(counting, 10);
    expect(calls).toBe(64);
    expect(mask.refresh(counting, 10)).toBe(0);
  });

  it('only re-probes the cells that scrolled into view when the centre moves', () => {
    const mask = filled(16, 1, 0, 0);
    mask.setCentre(0.4, 0);
    expect(mask.stale).toBe(0);
    mask.setCentre(2, 0);
    expect(mask.stale).toBe(2 * 16);
    const probed: number[] = [];
    mask.refresh((x, z) => {
      probed.push(x);
      return shed(x, z);
    }, Infinity);
    expect(Math.min(...probed)).toBeGreaterThanOrEqual(8);
    expect(mask.stale).toBe(0);
  });

  it('keeps answers right after scrolling across the roof', () => {
    const mask = filled(16, 1, 0, 0);
    for (let x = 0; x <= 30; x += 0.7) {
      mask.setCentre(x, 2);
      mask.refresh(shed, Infinity);
      expect(mask.isCovered(x, 1.6, 2)).toBe(x >= 10 && x < 20);
    }
  });

  it('refreshes everything after a teleport', () => {
    const mask = filled(16, 1, 0, 0);
    mask.setCentre(500, -300);
    expect(mask.stale).toBe(256);
  });

  it('stores cells at wrapped texel positions so a repeating texture lookup finds them', () => {
    const mask = filled(8, 2, 100, 0);
    const ix = Math.floor(101 / 2);
    const iz = Math.floor(1 / 2);
    const texel = (((iz % 8) + 8) % 8) * 8 + (((ix % 8) + 8) % 8);
    expect(mask.heights[texel]).toBe(shed(101, 1));
    expect(mask.heightAt(1000, 1000)).toBe(STALE_HEIGHT);
  });

  it('counts a version so the texture is uploaded only when cells change', () => {
    const mask = filled(8, 1, 0, 0);
    const version = mask.version;
    mask.refresh(shed, Infinity);
    expect(mask.version).toBe(version);
    mask.setCentre(3, 0);
    mask.refresh(shed, Infinity);
    expect(mask.version).toBeGreaterThan(version);
  });
});
