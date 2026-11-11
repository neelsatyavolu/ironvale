import { describe, expect, it } from 'vitest';
import { ALLEY, RAMP, TERRACE_Y } from '../../src/maps/harbor/layout';
import { freeSpans } from '../../src/maps/harbor/wall-detail';
import { blurOpen, boxBlur, spreadMax, streetLevel, toByte } from '../../src/maps/harbor/shade-grid';

describe('streetLevel', () => {
  it('is quay level in the main street and on the quay', () => {
    expect(streetLevel(20, -1)).toBe(0);
    expect(streetLevel(-40, 15)).toBe(0);
  });

  it('steps up to the terrace and the tiers behind it', () => {
    expect(streetLevel(0, -19)).toBe(TERRACE_Y);
    expect(streetLevel(0, -40)).toBeCloseTo(9.2);
    expect(streetLevel(0, -60)).toBeCloseTo(17.4);
  });

  it('climbs the alley steps and the east ramp', () => {
    const alleyX = (ALLEY.x0 + ALLEY.x1) / 2;
    expect(streetLevel(alleyX, ALLEY.stepsFromZ)).toBe(0);
    const halfway = ALLEY.stepsFromZ - (ALLEY.risers * ALLEY.tread) / 2;
    expect(streetLevel(alleyX, halfway)).toBeCloseTo(TERRACE_Y / 2);
    const rampX = (RAMP.x0 + RAMP.x1) / 2;
    expect(streetLevel(rampX, (RAMP.z0 + RAMP.z1) / 2)).toBeCloseTo(TERRACE_Y / 2);
    expect(streetLevel(rampX + 6, (RAMP.z0 + RAMP.z1) / 2)).toBe(0);
  });
});

describe('boxBlur', () => {
  it('keeps a flat field flat and conserves a spike away from the edges', () => {
    const flat = new Float32Array(25).fill(0.4);
    for (const value of boxBlur(flat, 5, 5, 1, 2)) expect(value).toBeCloseTo(0.4);
    const spike = new Float32Array(81);
    spike[40] = 1;
    const blurred = boxBlur(spike, 9, 9, 1, 1);
    expect(blurred.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    expect(blurred[40]).toBeCloseTo(1 / 9);
    expect(spike[40]).toBe(1);
  });
});

describe('blurOpen', () => {
  it('does not let solid cells drain the light beside them', () => {
    // Left half lit street, right half building.
    const values = new Float32Array(16);
    const solid = new Uint8Array(16);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        if (col < 2) values[row * 4 + col] = 1;
        else solid[row * 4 + col] = 1;
      }
    }
    const out = blurOpen(values, solid, 4, 4, 1, 1);
    expect(out[1]).toBeCloseTo(1);
    // The first solid column takes the street's value, so a wall sampled across the edge stays lit.
    expect(out[2]).toBeCloseTo(1);
  });
});

describe('spreadMax', () => {
  it('grows a roof height one cell per pass', () => {
    const values = new Float32Array(49);
    values[24] = 9;
    const once = spreadMax(values, 7, 7, 1);
    expect(once[24 - 8]).toBe(9);
    expect(once[24 - 2]).toBe(0);
    expect(spreadMax(values, 7, 7, 2)[24 - 2]).toBe(9);
  });
});

describe('toByte', () => {
  it('clamps to the byte range', () => {
    expect(toByte(-1)).toBe(0);
    expect(toByte(0.5)).toBe(128);
    expect(toByte(3)).toBe(255);
  });
});

describe('freeSpans', () => {
  it('returns the wall between openings, inside the corner margin', () => {
    expect(freeSpans(10, [[2, 3], [6, 7.5]], 0.5)).toEqual([[0.5, 2], [3, 6], [7.5, 9.5]]);
  });

  it('merges overlapping blocks and copes with blocks past the ends', () => {
    expect(freeSpans(8, [[3, 5], [-1, 1], [4, 6], [7.5, 9]])).toEqual([[1, 3], [6, 7.5]]);
    expect(freeSpans(4, [[-1, 5]])).toEqual([]);
  });
});
