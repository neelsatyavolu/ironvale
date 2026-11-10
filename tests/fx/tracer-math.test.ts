import { describe, expect, it } from 'vitest';
import {
  MAX_VISIBLE_SPEED,
  MIN_VISIBLE_SPEED,
  showLocalTracer,
  tracerLength,
  visibleTracerSpeed,
} from '../../src/fx/tracer-math';

describe('visibleTracerSpeed', () => {
  it('caps a rifle round so the streak can be followed', () => {
    expect(visibleTracerSpeed(880, 200)).toBe(MAX_VISIBLE_SPEED);
  });

  it('slows close shots so they stay on screen for a few frames', () => {
    const speed = visibleTracerSpeed(880, 8);
    expect(8 / speed).toBeGreaterThanOrEqual(0.06);
    expect(speed).toBeGreaterThanOrEqual(MIN_VISIBLE_SPEED);
  });

  it('never exceeds the real muzzle velocity', () => {
    expect(visibleTracerSpeed(120, 300)).toBe(120);
  });

  it('gets faster with distance', () => {
    expect(visibleTracerSpeed(880, 30)).toBeGreaterThan(visibleTracerSpeed(880, 10));
  });
});

describe('tracerLength', () => {
  it('is never longer than most of the path', () => {
    expect(tracerLength(300, 2)).toBeLessThanOrEqual(2 * 0.7);
    expect(tracerLength(300, 500)).toBeLessThanOrEqual(12);
  });

  it('grows with speed', () => {
    expect(tracerLength(300, 500)).toBeGreaterThan(tracerLength(100, 500));
  });
});

describe('showLocalTracer', () => {
  it('shows one round in every few for single projectiles', () => {
    const shown = Array.from({ length: 9 }, (_, i) => showLocalTracer(i, 1));
    expect(shown.filter(Boolean).length).toBe(3);
    expect(shown[0]).toBe(true);
  });

  it('shows only a couple of pellets from a shotgun blast', () => {
    const shown = Array.from({ length: 9 }, (_, i) => showLocalTracer(i, 9));
    expect(shown.filter(Boolean).length).toBeLessThanOrEqual(3);
    expect(shown.filter(Boolean).length).toBeGreaterThanOrEqual(1);
  });
});
