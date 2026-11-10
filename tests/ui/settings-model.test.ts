import { describe, expect, it } from 'vitest';
import { graphicsForTier } from '../../src/core/settings';
import { applyTier, matchTier, patchGraphics, presetLabel } from '../../src/ui/settings-model';

describe('graphics preset view-model', () => {
  it('labels an untouched tier by its name', () => {
    expect(presetLabel(graphicsForTier('low'))).toBe('Low');
    expect(presetLabel(graphicsForTier('medium'))).toBe('Medium');
    expect(presetLabel(graphicsForTier('high'))).toBe('High');
    expect(presetLabel(graphicsForTier('ultra'))).toBe('Ultra');
  });

  it('turns to Custom when one switch leaves the preset', () => {
    const changed = patchGraphics(graphicsForTier('high'), { reflections: false });
    expect(changed.reflections).toBe(false);
    expect(matchTier(changed)).toBeNull();
    expect(presetLabel(changed)).toBe('Custom');
  });

  it('returns to the preset when the switch is put back', () => {
    const off = patchGraphics(graphicsForTier('high'), { bloom: false });
    const on = patchGraphics(off, { bloom: true });
    expect(presetLabel(on)).toBe('High');
    expect(on.tier).toBe('high');
  });

  it('does not count frame rate or dynamic resolution as leaving the preset', () => {
    const changed = patchGraphics(graphicsForTier('medium'), { targetFps: 120, dynamicResolution: false });
    expect(presetLabel(changed)).toBe('Medium');
  });

  it('keeps the last tier while custom so tier-dependent passes stay stable', () => {
    const changed = patchGraphics(graphicsForTier('ultra'), { renderScale: 0.7 });
    expect(changed.tier).toBe('ultra');
    expect(presetLabel(changed)).toBe('Custom');
  });

  it('adopts another tier when the values land exactly on it', () => {
    // High and ultra differ only in render scale, detail density and resolution of some passes.
    const step = patchGraphics(graphicsForTier('high'), { renderScale: 1 });
    const landed = patchGraphics(step, { detailDensity: 1 });
    expect(landed.tier).toBe('ultra');
    expect(presetLabel(landed)).toBe('Ultra');
  });

  it('applies a tier over custom values and keeps frame rate choices', () => {
    const custom = patchGraphics(graphicsForTier('high'), { bloom: false, targetFps: 30, dynamicResolution: false });
    const next = applyTier(custom, 'low');
    expect(next).toEqual({ ...graphicsForTier('low'), targetFps: 30, dynamicResolution: false });
    expect(presetLabel(next)).toBe('Low');
  });

  it('does not mutate its input', () => {
    const base = graphicsForTier('high');
    const frozen = Object.freeze({ ...base });
    expect(() => patchGraphics(frozen, { bloom: false })).not.toThrow();
    expect(frozen.bloom).toBe(true);
  });
});
