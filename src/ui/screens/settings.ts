import {
  CONTROL_PRESETS,
  type AntiAliasing,
  type ControlPreset,
  type GraphicsSettings,
  type QualityTier,
  type Settings,
  type TextureTier,
} from '../../core/settings';
import type { GameContext } from '../../game/contracts';
import { button, row, section, segmented, slider, toggle, type Control, type SliderSpec } from '../controls';
import { h, setAttrs } from '../dom';
import { applyTier, matchTier, patchGraphics, presetLabel, tierName, TIERS } from '../settings-model';
import '../styles/sheet.css';

export type SettingsTab = 'graphics' | 'controls' | 'audio' | 'gameplay';

const TABS: readonly { id: SettingsTab; label: string }[] = [
  { id: 'graphics', label: 'Graphics' },
  { id: 'controls', label: 'Controls' },
  { id: 'audio', label: 'Audio' },
  { id: 'gameplay', label: 'Gameplay' },
];

export interface SettingsActions {
  close(): void;
  openControls(): void;
}

export interface SettingsScreen {
  readonly element: HTMLElement;
  open(tab?: SettingsTab): void;
  dispose(): void;
}

type Sync = (settings: Settings) => void;

const percent = (value: number): string => `${Math.round(value)}%`;
const percentSpec = (label: string, min = 0, max = 100): SliderSpec => ({ label, min, max, step: 5, format: percent });

export function createSettings(ctx: GameContext, actions: SettingsActions): SettingsScreen {
  const store = ctx.settings;
  const syncs: Sync[] = [];

  /** Bind a control to a value read from settings; returns its row. */
  function bound<T>(label: string, control: Control<T>, read: (settings: Settings) => T, note?: string): HTMLElement {
    syncs.push((settings) => control.set(read(settings)));
    return row(label, control.element, note);
  }

  const graphics = (patch: Partial<Omit<GraphicsSettings, 'tier'>>): void =>
    store.update('graphics', patchGraphics(store.value.graphics, patch));
  const switchRow = (label: string, key: 'reflections' | 'ambientOcclusion' | 'volumetricLight' | 'bloom' | 'filmGrain' | 'dynamicResolution', note?: string): HTMLElement =>
    bound(label, toggle(label, (value) => graphics({ [key]: value })), (s) => s.graphics[key], note);

  // ---- Graphics
  const presetState = h('span', 'iv-preset-state');
  const presetControl = segmented<QualityTier>(
    'Quality preset',
    TIERS.map((tier) => ({ value: tier, label: tierName(tier) })),
    (tier) => store.update('graphics', applyTier(store.value.graphics, tier)),
  );
  syncs.push((settings) => {
    presetControl.set(matchTier(settings.graphics));
    const label = presetLabel(settings.graphics);
    presetState.textContent = label === 'Custom' ? label : '';
  });
  const quality = section(
    'Quality',
    row('Preset', h('div', 'iv-row__controls', presetState, presetControl.element)),
    bound(
      'Render scale',
      slider({ label: 'Render scale', min: 50, max: 100, step: 5, format: percent }, (value) => graphics({ renderScale: value / 100 })),
      (s) => Math.round(s.graphics.renderScale * 100),
    ),
    switchRow('Dynamic resolution', 'dynamicResolution', 'Lowers the render scale when frames run long.'),
    bound(
      'Target frame rate',
      segmented<GraphicsSettings['targetFps']>(
        'Target frame rate',
        [
          { value: 30, label: '30' },
          { value: 60, label: '60' },
          { value: 120, label: '120' },
        ],
        (targetFps) => graphics({ targetFps }),
      ),
      (s) => s.graphics.targetFps,
    ),
    bound(
      'Shadows',
      segmented<GraphicsSettings['shadowMapSize']>(
        'Shadows',
        [
          { value: 0, label: 'Off' },
          { value: 1024, label: 'Low' },
          { value: 2048, label: 'Medium' },
          { value: 4096, label: 'High' },
        ],
        (shadowMapSize) => graphics({ shadowMapSize }),
      ),
      (s) => s.graphics.shadowMapSize,
    ),
    bound(
      'Textures',
      segmented<TextureTier>(
        'Textures',
        [
          { value: '1k', label: '1K' },
          { value: '2k', label: '2K' },
        ],
        (textures) => graphics({ textures }),
      ),
      (s) => s.graphics.textures,
      'From the next map you load.',
    ),
    bound(
      'Anti-aliasing',
      segmented<AntiAliasing>(
        'Anti-aliasing',
        [
          { value: 'none', label: 'Off' },
          { value: 'fxaa', label: 'FXAA' },
          { value: 'traa', label: 'TRAA' },
        ],
        (antiAliasing) => graphics({ antiAliasing }),
      ),
      (s) => s.graphics.antiAliasing,
    ),
  );
  const effects = section(
    'Effects',
    switchRow('Reflections', 'reflections'),
    switchRow('Ambient occlusion', 'ambientOcclusion'),
    switchRow('Light shafts', 'volumetricLight'),
    switchRow('Bloom', 'bloom'),
    switchRow('Film grain', 'filmGrain'),
    bound(
      'Detail density',
      slider(percentSpec('Detail density', 10), (value) => graphics({ detailDensity: value / 100 })),
      (s) => Math.round(s.graphics.detailDensity * 100),
      'Grass, debris and rain. From the next map.',
    ),
    bound(
      'Particle density',
      slider(percentSpec('Particle density', 10), (value) => graphics({ particleDensity: value / 100 })),
      (s) => Math.round(s.graphics.particleDensity * 100),
    ),
  );

  // ---- Controls
  const look = section(
    'Look',
    bound(
      'Preset',
      segmented<ControlPreset>(
        'Control preset',
        [
          { value: 'trackpad', label: 'Trackpad' },
          { value: 'mouse', label: 'Mouse' },
        ],
        (preset) => store.update('controls', CONTROL_PRESETS[preset]),
      ),
      (s) => s.controls.preset,
      'Resets the values below.',
    ),
    bound(
      'Sensitivity',
      slider({ label: 'Sensitivity', min: 5, max: 80, step: 1, format: (value) => String(value) }, (sensitivity) =>
        store.update('controls', { sensitivity }),
      ),
      (s) => s.controls.sensitivity,
    ),
    bound(
      'Aimed sensitivity',
      slider({ label: 'Aimed sensitivity', min: 30, max: 150, step: 5, format: percent }, (value) =>
        store.update('controls', { adsSensitivity: value / 100 }),
      ),
      (s) => Math.round(s.controls.adsSensitivity * 100),
    ),
    bound(
      'Look smoothing',
      slider(percentSpec('Look smoothing'), (value) => store.update('controls', { lookSmoothing: value / 100 })),
      (s) => Math.round(s.controls.lookSmoothing * 100),
      'Evens out trackpad movement.',
    ),
    bound('Invert Y', toggle('Invert Y', (invertY) => store.update('controls', { invertY })), (s) => s.controls.invertY),
    bound(
      'Raw input',
      toggle('Raw input', (rawInput) => store.update('controls', { rawInput })),
      (s) => s.controls.rawInput,
      'No pointer acceleration. Best with a mouse.',
    ),
  );
  const aim = section(
    'Aim',
    bound(
      'Aim button',
      segmented<boolean>(
        'Aim button',
        [
          { value: true, label: 'Toggle' },
          { value: false, label: 'Hold' },
        ],
        (adsToggle) => store.update('controls', { adsToggle }),
      ),
      (s) => s.controls.adsToggle,
    ),
    bound(
      'Aim assist',
      slider(percentSpec('Aim assist'), (value) => store.update('controls', { aimAssist: value / 100 })),
      (s) => Math.round(s.controls.aimAssist * 100),
      'Slows the view over a target and pulls toward it.',
    ),
    row('Key bindings', button('View controls', 'ghost', actions.openControls)),
  );

  // ---- Audio
  const volume = (label: string, key: 'master' | 'effects' | 'ambience' | 'interface'): HTMLElement =>
    bound(
      label,
      slider(percentSpec(label), (value) => store.update('audio', { [key]: value / 100 })),
      (s) => Math.round(s.audio[key] * 100),
    );
  const volumes = section(
    'Volume',
    volume('Master', 'master'),
    volume('Effects', 'effects'),
    volume('Ambience', 'ambience'),
    volume('Interface', 'interface'),
  );
  const output = section(
    'Output',
    bound(
      'HRTF positioning',
      toggle('HRTF positioning', (hrtf) => store.update('audio', { hrtf })),
      (s) => s.audio.hrtf,
      'Places sounds around you. Best on headphones.',
    ),
  );

  // ---- Gameplay
  const view = section(
    'View',
    bound(
      'Field of view',
      slider({ label: 'Field of view', min: 60, max: 100, step: 1, format: (value) => `${value}°` }, (fov) =>
        store.update('gameplay', { fov }),
      ),
      (s) => s.gameplay.fov,
    ),
    bound(
      'Head bob',
      slider(percentSpec('Head bob'), (value) => store.update('gameplay', { headBob: value / 100 })),
      (s) => Math.round(s.gameplay.headBob * 100),
    ),
  );
  const hud = section(
    'HUD',
    bound('Crosshair', toggle('Crosshair', (crosshair) => store.update('gameplay', { crosshair })), (s) => s.gameplay.crosshair),
    bound(
      'Hit markers',
      toggle('Hit markers', (showHitMarkers) => store.update('gameplay', { showHitMarkers })),
      (s) => s.gameplay.showHitMarkers,
    ),
    row('Performance readout', h('span', 'iv-row__hint', 'Press ` during a match')),
  );

  const panels: Readonly<Record<SettingsTab, HTMLElement>> = {
    graphics: h('div', 'iv-sheet__cols', quality.element, effects.element),
    controls: h('div', 'iv-sheet__cols', look.element, aim.element),
    audio: h('div', 'iv-sheet__cols', volumes.element, output.element),
    gameplay: h('div', 'iv-sheet__cols', view.element, hud.element),
  };

  const tabList = setAttrs(h('div', 'iv-tabs'), { role: 'tablist' });
  const tabButtons = TABS.map(({ id, label }) => {
    const tab = setAttrs(h('button', 'iv-tab', label), { type: 'button', role: 'tab', 'aria-selected': 'false', 'data-nav': '' });
    tab.addEventListener('click', () => select(id));
    tabList.append(tab);
    setAttrs(panels[id], { role: 'tabpanel', 'aria-label': label });
    return { id, tab };
  });

  const body = h('div', 'iv-sheet__body', ...Object.values(panels));
  const element = h(
    'div',
    'iv-screen iv-sheet',
    h(
      'div',
      'iv-sheet__panel',
      h('header', 'iv-sheet__head', h('h2', 'iv-headline', 'Settings'), h('span', 'iv-label', 'Changes apply as you make them')),
      tabList,
      body,
      h(
        'footer',
        'iv-sheet__foot',
        button('Back', 'ghost', actions.close),
        h('span', 'iv-keys', h('span', '', h('b', '', 'Esc'), ' back')),
      ),
    ),
  );

  let current: SettingsTab = 'graphics';
  function select(id: SettingsTab): void {
    current = id;
    for (const item of tabButtons) {
      const active = item.id === id;
      item.tab.setAttribute('aria-selected', String(active));
      if (active) item.tab.setAttribute('data-nav-default', '');
      else item.tab.removeAttribute('data-nav-default');
      panels[item.id].hidden = !active;
    }
    body.scrollTop = 0;
  }

  const syncAll = (settings: Settings): void => {
    for (const sync of syncs) sync(settings);
  };
  const unsubscribe = store.subscribe(syncAll);
  syncAll(store.value);
  select(current);

  return {
    element,
    open(tab?: SettingsTab): void {
      select(tab ?? current);
    },
    dispose: unsubscribe,
  };
}
