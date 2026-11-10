/**
 * Player settings and graphics quality tiers. Settings are plain immutable
 * objects; `SettingsStore.update` replaces the object and notifies listeners.
 */

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';
export type AntiAliasing = 'none' | 'fxaa' | 'traa';
export type TextureTier = '1k' | '2k';
export type ControlPreset = 'trackpad' | 'mouse';
export type Difficulty = 'recruit' | 'regular' | 'veteran' | 'elite';

export interface GraphicsSettings {
  readonly tier: QualityTier;
  /** Internal resolution as a fraction of the display's device pixels (0.5 - 1). */
  readonly renderScale: number;
  /** Lower the render scale automatically when frame time exceeds the target. */
  readonly dynamicResolution: boolean;
  readonly targetFps: 30 | 60 | 120;
  /** Sun shadow map size in texels; 0 turns shadows off. */
  readonly shadowMapSize: 0 | 1024 | 2048 | 4096;
  readonly ambientOcclusion: boolean;
  readonly reflections: boolean;
  readonly volumetricLight: boolean;
  readonly bloom: boolean;
  readonly antiAliasing: AntiAliasing;
  readonly textures: TextureTier;
  readonly anisotropy: 1 | 4 | 8 | 16;
  /** 0 - 1 multiplier for grass, debris, rain and other instanced detail. */
  readonly detailDensity: number;
  /** 0 - 1 multiplier for particle counts (impacts, smoke, shells). */
  readonly particleDensity: number;
  readonly filmGrain: boolean;
}

export interface ControlSettings {
  readonly preset: ControlPreset;
  /** Degrees of turn per 1000 px of pointer travel. */
  readonly sensitivity: number;
  /** Multiplier applied to sensitivity while aiming down sights. */
  readonly adsSensitivity: number;
  readonly invertY: boolean;
  /** true: press once to aim, again to stop. false: hold to aim. */
  readonly adsToggle: boolean;
  /** Slows the view and gently pulls toward a target under the reticle. 0 = off, 1 = full. */
  readonly aimAssist: number;
  /** Smooths jittery trackpad deltas. 0 = raw, 1 = heavy. */
  readonly lookSmoothing: number;
  /** Ask the browser for unaccelerated pointer movement. Better for mice; trackpads usually feel slow with it. */
  readonly rawInput: boolean;
}

export interface AudioSettings {
  readonly master: number;
  readonly effects: number;
  readonly ambience: number;
  readonly interface: number;
  /** Head-related transfer function panning. Costs CPU; off uses equal-power panning. */
  readonly hrtf: boolean;
}

export interface GameplaySettings {
  readonly difficulty: Difficulty;
  readonly fov: number;
  readonly headBob: number;
  readonly showHitMarkers: boolean;
  readonly crosshair: boolean;
}

export interface Settings {
  readonly graphics: GraphicsSettings;
  readonly controls: ControlSettings;
  readonly audio: AudioSettings;
  readonly gameplay: GameplaySettings;
}

type TierFields = Omit<GraphicsSettings, 'tier' | 'targetFps' | 'dynamicResolution'>;

export const QUALITY_PRESETS: Readonly<Record<QualityTier, TierFields>> = {
  // Low is for older integrated GPUs: half the display's pixels each way, no multi-pass effects
  // (bloom alone is a dozen passes), and the engine redraws the shadow map every other frame.
  low: {
    renderScale: 0.5,
    shadowMapSize: 1024,
    ambientOcclusion: false,
    reflections: false,
    volumetricLight: false,
    bloom: false,
    antiAliasing: 'fxaa',
    textures: '1k',
    anisotropy: 4,
    detailDensity: 0.35,
    particleDensity: 0.5,
    filmGrain: false,
  },
  medium: {
    renderScale: 0.75,
    shadowMapSize: 2048,
    ambientOcclusion: true,
    reflections: false,
    volumetricLight: true,
    bloom: true,
    antiAliasing: 'traa',
    textures: '1k',
    anisotropy: 8,
    detailDensity: 0.6,
    particleDensity: 0.75,
    filmGrain: true,
  },
  high: {
    renderScale: 0.85,
    shadowMapSize: 4096,
    ambientOcclusion: true,
    reflections: true,
    volumetricLight: true,
    bloom: true,
    antiAliasing: 'traa',
    textures: '2k',
    anisotropy: 16,
    detailDensity: 0.85,
    particleDensity: 1,
    filmGrain: true,
  },
  ultra: {
    renderScale: 1,
    shadowMapSize: 4096,
    ambientOcclusion: true,
    reflections: true,
    volumetricLight: true,
    bloom: true,
    antiAliasing: 'traa',
    textures: '2k',
    anisotropy: 16,
    detailDensity: 1,
    particleDensity: 1,
    filmGrain: true,
  },
};

export function graphicsForTier(tier: QualityTier, base?: GraphicsSettings): GraphicsSettings {
  return {
    targetFps: base?.targetFps ?? 60,
    dynamicResolution: base?.dynamicResolution ?? true,
    ...QUALITY_PRESETS[tier],
    tier,
  };
}

/**
 * Quality tier for a first run, from the GPU name the browser reports. Returns
 * null when the name says nothing useful (Safari reports only
 * "Apple GPU"), in which case the default tier stands.
 */
export function tierForGpu(name: string): QualityTier | null {
  // Software rasterisers and Intel graphics (integrated on every Mac that has it).
  if (/swiftshader|llvmpipe|software|\bintel\b/i.test(name)) return 'low';
  // The base M1 and M2 chips (fanless MacBook Air class), not their Pro, Max or Ultra versions.
  if (/apple m[12](?!\d)(?!\s*(pro|max|ultra))/i.test(name)) return 'medium';
  return null;
}

export const CONTROL_PRESETS: Readonly<Record<ControlPreset, ControlSettings>> = {
  trackpad: {
    preset: 'trackpad',
    sensitivity: 130,
    adsSensitivity: 0.6,
    invertY: false,
    adsToggle: true,
    aimAssist: 0.6,
    lookSmoothing: 0.35,
    rawInput: false,
  },
  mouse: {
    preset: 'mouse',
    sensitivity: 70,
    adsSensitivity: 0.7,
    invertY: false,
    adsToggle: false,
    aimAssist: 0,
    lookSmoothing: 0,
    rawInput: true,
  },
};

export const DEFAULT_SETTINGS: Settings = {
  graphics: graphicsForTier('high'),
  controls: CONTROL_PRESETS.trackpad,
  audio: { master: 0.9, effects: 1, ambience: 0.8, interface: 0.7, hrtf: true },
  gameplay: { difficulty: 'regular', fov: 78, headBob: 1, showHitMarkers: true, crosshair: true },
};

const STORAGE_KEY = 'ironvale.settings.v1';

type Listener = (next: Settings, previous: Settings) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What a stored value may be: one of a list, or a number inside `[min, max]` (clamped). Other keys only need the right type. */
type Rule = readonly (string | number)[] | { readonly min: number; readonly max: number };
type Rules<T> = { readonly [K in keyof T]?: Rule };

const UNIT: Rule = { min: 0, max: 1 };
const GRAPHICS_RULES: Rules<GraphicsSettings> = {
  tier: ['low', 'medium', 'high', 'ultra'],
  renderScale: { min: 0.25, max: 1 },
  targetFps: [30, 60, 120],
  shadowMapSize: [0, 1024, 2048, 4096],
  antiAliasing: ['none', 'fxaa', 'traa'],
  textures: ['1k', '2k'],
  anisotropy: [1, 4, 8, 16],
  detailDensity: UNIT,
  particleDensity: UNIT,
};
const CONTROL_RULES: Rules<ControlSettings> = {
  preset: ['trackpad', 'mouse'],
  sensitivity: { min: 1, max: 400 },
  adsSensitivity: { min: 0.1, max: 2 },
  aimAssist: UNIT,
  lookSmoothing: UNIT,
};
const AUDIO_RULES: Rules<AudioSettings> = { master: UNIT, effects: UNIT, ambience: UNIT, interface: UNIT };
const GAMEPLAY_RULES: Rules<GameplaySettings> = {
  difficulty: ['recruit', 'regular', 'veteran', 'elite'],
  fov: { min: 50, max: 120 },
  headBob: UNIT,
};

/** Merge stored values over defaults, keeping only keys whose type matches the default and whose value the rules allow. */
function mergeSection<T extends object>(defaults: T, stored: unknown, rules: Rules<T>): T {
  if (!isRecord(stored)) return defaults;
  const merged: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = stored[key];
    if (value === undefined || typeof value !== typeof fallback) continue;
    const rule = (rules as Record<string, Rule | undefined>)[key];
    if (!rule) merged[key] = value;
    else if (Array.isArray(rule)) {
      if (rule.includes(value as string | number)) merged[key] = value;
    } else if (typeof value === 'number') {
      const range = rule as { readonly min: number; readonly max: number };
      merged[key] = Math.min(range.max, Math.max(range.min, value));
    }
  }
  return merged as T;
}

export function parseSettings(raw: string | null): Settings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const data: unknown = JSON.parse(raw);
    if (!isRecord(data)) return DEFAULT_SETTINGS;
    // The first release shipped look speeds that were far too slow. Anyone still
    // on one of those untouched defaults gets the new one.
    if (isRecord(data.controls)) {
      const old = data.controls.preset === 'mouse' ? 22 : 34;
      if (data.controls.sensitivity === old) {
        const preset = data.controls.preset === 'mouse' ? 'mouse' : 'trackpad';
        data.controls = { ...data.controls, sensitivity: CONTROL_PRESETS[preset].sensitivity };
      }
    }
    return {
      graphics: mergeSection(DEFAULT_SETTINGS.graphics, data.graphics, GRAPHICS_RULES),
      controls: mergeSection(DEFAULT_SETTINGS.controls, data.controls, CONTROL_RULES),
      audio: mergeSection(DEFAULT_SETTINGS.audio, data.audio, AUDIO_RULES),
      gameplay: mergeSection(DEFAULT_SETTINGS.gameplay, data.gameplay, GAMEPLAY_RULES),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export class SettingsStore {
  private current: Settings;
  private readonly listeners = new Set<Listener>();

  /**
   * `gpuName` is asked once, on a first run with nothing saved, to pick a
   * starting quality tier for slower GPUs. The pick is saved so it is not
   * repeated and the player's later choices always win.
   */
  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage(),
    gpuName: () => string | null = readGpuName,
  ) {
    let raw: string | null = null;
    let firstRun = false;
    try {
      raw = storage?.getItem(STORAGE_KEY) ?? null;
      firstRun = storage !== null && raw === null;
    } catch (error) {
      console.warn('Could not read saved settings', error);
    }
    this.current = parseSettings(raw);
    if (firstRun) this.pickFirstRunTier(gpuName);
  }

  private pickFirstRunTier(gpuName: () => string | null): void {
    const name = gpuName();
    const tier = name ? tierForGpu(name) : null;
    if (!tier || tier === this.current.graphics.tier) return;
    this.current = { ...this.current, graphics: graphicsForTier(tier, this.current.graphics) };
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.current));
    } catch (error) {
      console.warn('Could not save settings', error);
    }
  }

  get value(): Settings {
    return this.current;
  }

  /** Replace one section. Pass only the fields that change. */
  update<K extends keyof Settings>(section: K, patch: Partial<Settings[K]>): void {
    const previous = this.current;
    this.current = { ...previous, [section]: { ...previous[section], ...patch } };
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.current));
    } catch (error) {
      console.warn('Could not save settings', error);
    }
    for (const listener of [...this.listeners]) listener(this.current, previous);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The GPU name from a throwaway WebGL context, or null where there is no DOM or the name is hidden. */
function readGpuName(): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const gl = document.createElement('canvas').getContext('webgl2', { powerPreference: 'high-performance' });
    if (!gl) return null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name: unknown = gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}
