import { describe, expect, it } from 'vitest';
import { DEPTH, fullness, hullPoint, section, stationX, type HullForm } from '../../src/maps/harbor/hull-shape';

const gozzo: HullForm = { length: 6, beam: 2.2, stern: 'pointed' };
const skiff: HullForm = { length: 5.6, beam: 2, stern: 'transom' };

describe('hull shape', () => {
  it('is widest near the middle and never wider than the beam', () => {
    let widest = 0;
    let at = 0;
    for (let i = 0; i <= 100; i++) {
      const half = section(i / 100, gozzo).half(1);
      expect(half).toBeLessThanOrEqual(gozzo.beam / 2 + 1e-9);
      if (half > widest) {
        widest = half;
        at = i / 100;
      }
    }
    expect(widest).toBeCloseTo(gozzo.beam / 2, 2);
    expect(at).toBeGreaterThan(0.4);
    expect(at).toBeLessThan(0.62);
  });

  it('closes to a point at both ends of a double-ender', () => {
    expect(fullness(0, gozzo)).toBeLessThan(0.05);
    expect(fullness(1, gozzo)).toBeLessThan(0.05);
  });

  it('keeps a transom stern broad and still closes the bow', () => {
    expect(fullness(0, skiff)).toBeGreaterThan(0.7);
    expect(fullness(1, skiff)).toBeLessThan(0.05);
    // No step where the transom blend hands over to the body curve.
    for (let i = 0; i < 100; i++) expect(Math.abs(fullness((i + 1) / 100, skiff) - fullness(i / 100, skiff))).toBeLessThan(0.09);
  });

  it('sweeps the sheer up to the ends, highest at the bow', () => {
    const mid = section(0.5, gozzo).gunwale;
    expect(mid).toBeCloseTo(DEPTH);
    expect(section(1, gozzo).gunwale).toBeGreaterThan(section(0, gozzo).gunwale);
    expect(section(0, gozzo).gunwale).toBeGreaterThan(mid);
  });

  it('runs from keel to gunwale as the girth parameter goes 0 to 1', () => {
    const shape = section(0.4, gozzo);
    expect(shape.height(0)).toBeCloseTo(shape.keel);
    expect(shape.height(1)).toBeCloseTo(shape.gunwale);
    expect(shape.half(0)).toBe(0);
    for (let j = 0; j < 10; j++) {
      expect(shape.height((j + 1) / 10)).toBeGreaterThan(shape.height(j / 10));
      expect(shape.half((j + 1) / 10)).toBeGreaterThan(shape.half(j / 10));
    }
  });

  it('gives the half-breadth at a height that matches the girth curve', () => {
    const shape = section(0.55, skiff);
    for (const s of [0.2, 0.5, 0.9]) expect(shape.halfAt(shape.height(s))).toBeCloseTo(shape.half(s), 6);
    expect(shape.halfAt(shape.keel - 0.1)).toBe(0);
  });

  it('rakes the stem forward and stays inside a sane overall length', () => {
    expect(stationX(1, 1, gozzo)).toBeGreaterThan(stationX(1, 0, gozzo));
    expect(stationX(0, 1, gozzo)).toBeLessThan(stationX(0, 0, gozzo));
    expect(stationX(1, 1, gozzo) - stationX(0, 1, gozzo)).toBeLessThan(gozzo.length * 1.1);
    const [x, y, z] = hullPoint(0.5, 1, gozzo);
    expect(x).toBeCloseTo(0, 1);
    expect(y).toBeCloseTo(DEPTH);
    expect(z).toBeGreaterThan(1);
  });
});
