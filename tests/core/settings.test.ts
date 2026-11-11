import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, graphicsForTier, parseSettings, SettingsStore, tierForGpu } from '../../src/core/settings';

describe('settings', () => {
  it('falls back to defaults for missing or corrupt storage', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('{not json')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('[1,2]')).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps stored values of the right type and drops the rest', () => {
    const parsed = parseSettings(JSON.stringify({ gameplay: { fov: 90, difficulty: 7 }, audio: { master: 0.2 } }));
    expect(parsed.gameplay.fov).toBe(90);
    expect(parsed.gameplay.difficulty).toBe(DEFAULT_SETTINGS.gameplay.difficulty);
    expect(parsed.audio.master).toBe(0.2);
  });

  it('drops stored choices that no longer exist and clamps numbers out of range', () => {
    const parsed = parseSettings(
      JSON.stringify({
        graphics: { tier: 'cinematic', antiAliasing: 'msaa', textures: '8k', shadowMapSize: 99999, anisotropy: 3, targetFps: 144, renderScale: 40 },
        controls: { preset: 'gamepad', sensitivity: -5, lookSmoothing: 7 },
        audio: { master: 30 },
        gameplay: { difficulty: 'nightmare', fov: 900 },
      }),
    );
    expect(parsed.graphics).toEqual({ ...DEFAULT_SETTINGS.graphics, renderScale: 1 });
    expect(parsed.controls.preset).toBe(DEFAULT_SETTINGS.controls.preset);
    expect(parsed.controls.sensitivity).toBe(1);
    expect(parsed.controls.lookSmoothing).toBe(1);
    expect(parsed.audio.master).toBe(1);
    expect(parsed.gameplay.difficulty).toBe(DEFAULT_SETTINGS.gameplay.difficulty);
    expect(parsed.gameplay.fov).toBe(120);
  });

  it('shows the minimap for settings saved before it existed and keeps a saved choice', () => {
    expect(DEFAULT_SETTINGS.gameplay.minimap).toBe(true);
    expect(parseSettings(JSON.stringify({ gameplay: { fov: 90, crosshair: false } })).gameplay.minimap).toBe(true);
    expect(parseSettings(JSON.stringify({ gameplay: { minimap: false } })).gameplay.minimap).toBe(false);
    expect(parseSettings(JSON.stringify({ gameplay: { minimap: 'no' } })).gameplay.minimap).toBe(true);
  });

  it('survives storage that throws when read', () => {
    const storage = {
      getItem: (): string => {
        throw new Error('blocked');
      },
      setItem: (): void => undefined,
    };
    expect(new SettingsStore(storage).value).toEqual(DEFAULT_SETTINGS);
  });

  it('updates immutably, persists and notifies', () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) };
    const store = new SettingsStore(storage);
    const before = store.value;
    let notified = 0;
    store.subscribe(() => notified++);
    store.update('controls', { sensitivity: 50 });
    expect(store.value.controls.sensitivity).toBe(50);
    expect(before.controls.sensitivity).not.toBe(50);
    expect(notified).toBe(1);
    expect(new SettingsStore(storage).value.controls.sensitivity).toBe(50);
  });

  it('builds tiers that get heavier', () => {
    expect(graphicsForTier('low').reflections).toBe(false);
    expect(graphicsForTier('ultra').renderScale).toBe(1);
    expect(graphicsForTier('low').renderScale).toBeLessThan(graphicsForTier('high').renderScale);
    // Low runs no multi-pass effect at all, and every step up renders at least as many pixels.
    const low = graphicsForTier('low');
    expect([low.ambientOcclusion, low.reflections, low.volumetricLight, low.bloom]).toEqual([false, false, false, false]);
    expect(low.antiAliasing).not.toBe('traa');
    const scales = (['low', 'medium', 'high', 'ultra'] as const).map((tier) => graphicsForTier(tier).renderScale);
    expect([...scales].sort((a, b) => a - b)).toEqual(scales);
  });

  it('maps GPU names to a first-run tier', () => {
    expect(tierForGpu('ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 655, OpenGL 4.1)')).toBe('low');
    expect(tierForGpu('Google SwiftShader')).toBe('low');
    expect(tierForGpu('ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)')).toBe('medium');
    expect(tierForGpu('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)')).toBe('medium');
    expect(tierForGpu('ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)')).toBeNull();
    expect(tierForGpu('ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, Unspecified Version)')).toBeNull();
    expect(tierForGpu('ANGLE (Apple, ANGLE Metal Renderer: Apple M5 Max, Unspecified Version)')).toBeNull();
    expect(tierForGpu('Apple GPU')).toBeNull();
  });

  it('picks a tier from the GPU once, on a first run, and saves it', () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) };
    const first = new SettingsStore(storage, () => 'ANGLE (Intel Inc., Intel(R) UHD Graphics 630, OpenGL 4.1)');
    expect(first.value.graphics).toEqual(graphicsForTier('low'));
    expect(first.value.controls).toEqual(DEFAULT_SETTINGS.controls);
    // Saved, so a later run does not ask again and a different answer changes nothing.
    let asked = 0;
    const second = new SettingsStore(storage, () => {
      asked++;
      return 'Apple M5 Max';
    });
    expect(asked).toBe(0);
    expect(second.value.graphics.tier).toBe('low');
  });

  it('keeps the default tier when the GPU name is unknown, hidden or there is nowhere to save', () => {
    const saved = new Map<string, string>();
    const storage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) };
    expect(new SettingsStore(storage, () => 'Apple GPU').value).toEqual(DEFAULT_SETTINGS);
    expect(new SettingsStore(storage, () => null).value).toEqual(DEFAULT_SETTINGS);
    expect(saved.size).toBe(0);
    expect(new SettingsStore(null, () => 'Intel Iris').value).toEqual(DEFAULT_SETTINGS);
  });

  it('never replaces saved settings with a GPU pick', () => {
    const saved = new Map<string, string>([['ironvale.settings.v1', JSON.stringify({ graphics: graphicsForTier('ultra') })]]);
    const storage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) };
    expect(new SettingsStore(storage, () => 'Intel Iris').value.graphics.tier).toBe('ultra');
  });
});
