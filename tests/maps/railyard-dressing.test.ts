import { describe, expect, it } from 'vitest';
import { MeshBuilder } from '../../src/maps/railyard/builder';
import { POLES, WALL_LAMPS } from '../../src/maps/railyard/lamps';
import { LOGO_ROWS } from '../../src/maps/railyard/lettering';
import { BOUNDS, WAREHOUSE, YARD } from '../../src/maps/railyard/plan';
import { addWheel, chamferBox, hose } from '../../src/maps/railyard/shapes';

describe('railyard shapes', () => {
  it('cuts a chamfered box to exactly the size asked for, centred on the origin', () => {
    const geometry = chamferBox(1.2, 0.6, 2, 0.05);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    expect(box).not.toBeNull();
    if (!box) return;
    expect(box.min.x).toBeCloseTo(-0.6, 5);
    expect(box.max.x).toBeCloseTo(0.6, 5);
    expect(box.min.y).toBeCloseTo(-0.3, 5);
    expect(box.max.y).toBeCloseTo(0.3, 5);
    expect(box.min.z).toBeCloseTo(-1, 5);
    expect(box.max.z).toBeCloseTo(1, 5);
  });

  it('keeps a chamfer smaller than the thinnest side, so thin plates do not turn inside out', () => {
    const geometry = chamferBox(1, 0.04, 1, 0.1);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox?.max.y).toBeCloseTo(0.02, 5);
    expect(geometry.boundingBox?.min.y).toBeCloseTo(-0.02, 5);
  });

  it('builds a wheel that stands on the ground with its axle along X', () => {
    const rubber = new MeshBuilder();
    const metal = new MeshBuilder();
    addWheel(rubber, metal, [2, 0.5, -1], 0.5, 0.3, 1, { tyre: 0x111111, rim: 0xaaaaaa, hub: 0x333333 });
    const tyre = rubber.build();
    const box = tyre.boundingBox;
    expect(box).not.toBeNull();
    if (!box) return;
    expect(box.min.y).toBeGreaterThan(-0.02);
    expect(box.max.y).toBeLessThan(1.02);
    expect(box.max.x - box.min.x).toBeCloseTo(0.3, 2);
    expect((box.min.z + box.max.z) / 2).toBeCloseTo(-1, 3);
    expect(metal.empty).toBe(false);
  });

  it('lays a cable through its end points', () => {
    const geometry = hose([[0, 0.02, 0], [1, 0.02, 0.5], [2, 0.02, 0]], 0.02);
    geometry.computeBoundingBox();
    expect(geometry.boundingBox?.min.x).toBeCloseTo(0, 1);
    expect(geometry.boundingBox?.max.x).toBeCloseTo(2, 1);
    expect(geometry.boundingBox?.min.y).toBeGreaterThanOrEqual(-0.001);
  });
});

describe('railyard lamps', () => {
  it('hangs every bulkhead lamp on a wall, inside the bounds, facing along one axis', () => {
    expect(WALL_LAMPS.length).toBeGreaterThanOrEqual(12);
    for (const lamp of WALL_LAMPS) {
      expect(Math.abs(lamp.nx) + Math.abs(lamp.nz)).toBe(1);
      expect(lamp.x).toBeGreaterThanOrEqual(BOUNDS.min[0]);
      expect(lamp.x).toBeLessThanOrEqual(BOUNDS.max[0]);
      expect(lamp.z).toBeGreaterThanOrEqual(BOUNDS.min[2]);
      expect(lamp.z).toBeLessThanOrEqual(BOUNDS.max[2]);
      expect(lamp.y).toBeGreaterThan(2.5);
      expect(lamp.y).toBeLessThan(WAREHOUSE.eaves);
    }
  });

  it('keeps the floodlight masts inside the yard', () => {
    for (const [x, z] of POLES) {
      expect(x).toBeGreaterThan(YARD.west);
      expect(x).toBeLessThan(YARD.east);
      expect(z).toBeGreaterThan(YARD.quay);
      expect(z).toBeLessThan(YARD.south);
    }
  });
});

describe('railyard lettering', () => {
  it('has no duplicate rows, so every sign maps to one strip of the atlas', () => {
    expect(new Set(LOGO_ROWS).size).toBe(LOGO_ROWS.length);
  });

  it('carries the warning signs and container serials the dressing uses', () => {
    for (const text of ['HIGH VOLTAGE', 'NO ENTRY', 'CAUTION', 'AUTHORISED ONLY', 'MAX GR 30480 KG', 'RELAY 01'] as const) {
      expect(LOGO_ROWS).toContain(text);
    }
  });
});
