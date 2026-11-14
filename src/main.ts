import { freezeVisuals } from './core/freeze';
import { graphicsForTier, SettingsStore, type GraphicsSettings, type QualityTier } from './core/settings';
import { Game } from './game/game';

declare global {
  interface Window {
    /** Developer and screenshot hook. */
    __ironvale?: { game: Game; ready: boolean; error: string | null };
  }
}

const DEG = Math.PI / 180;

async function boot(): Promise<void> {
  const canvas = document.getElementById('view');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing #view canvas');
  const view = new URLSearchParams(location.search).get('view');
  if (view) {
    const { runViewer } = await import('./dev/viewer');
    const { engine } = await runViewer(canvas, view);
    window.__ironvale = { game: { engine } as unknown as Game, ready: true, error: null };
    return;
  }
  debugFreeze();
  const game = await Game.create(canvas, debugSettings());
  const hook = { game, ready: false, error: null as string | null };
  window.__ironvale = hook;

  // ?autostart&map=range&bots=0&pose=x,y,z,yawDeg,pitchDeg starts a match with no menu (screenshots, tests).
  const params = new URLSearchParams(location.search);
  if (!params.has('autostart')) {
    hook.ready = true;
    return;
  }
  await game.startMatch({
    mapId: params.get('map') ?? 'range',
    mode: 'skirmish',
    difficulty: game.settings.value.gameplay.difficulty,
    botCount: Number(params.get('bots') ?? 0),
  });
  const pose = params.get('pose')?.split(',').map(Number);
  if (pose && pose.length === 5 && pose.every(Number.isFinite)) {
    const [x, y, z, yaw, pitch] = pose as [number, number, number, number, number];
    game.debugPose(x, y, z, yaw * DEG, pitch * DEG);
  }
  hook.ready = true;
}

/**
 * Developer overrides that are never saved: ?q=low|medium|high|ultra picks a
 * quality tier (textures and detail included, since it applies before the map
 * loads) and ?no=ssr,ao,godrays,bloom,aa,grain,shadows switches effects off.
 * Returns undefined when neither is present, so normal saved settings apply.
 */
function debugSettings(): SettingsStore | undefined {
  const params = new URLSearchParams(location.search);
  const tier = params.get('q');
  const off = new Set((params.get('no') ?? '').split(',').filter(Boolean));
  if (!tier && off.size === 0) return undefined;
  const tiers: readonly string[] = ['low', 'medium', 'high', 'ultra'];
  const store = new SettingsStore(null);
  const base: GraphicsSettings =
    tier && tiers.includes(tier) ? graphicsForTier(tier as QualityTier) : store.value.graphics;
  store.update('graphics', {
    ...base,
    dynamicResolution: false,
    reflections: base.reflections && !off.has('ssr'),
    ambientOcclusion: base.ambientOcclusion && !off.has('ao'),
    volumetricLight: base.volumetricLight && !off.has('godrays'),
    bloom: base.bloom && !off.has('bloom'),
    antiAliasing: off.has('aa') ? 'none' : base.antiAliasing,
    filmGrain: base.filmGrain && !off.has('grain'),
    shadowMapSize: off.has('shadows') ? 0 : base.shadowMapSize,
  });
  return store;
}

/**
 * Developer switch for screenshot parity captures: ?freeze holds everything
 * animated for looks (shader clocks, water, lamp flicker, boats, weather and
 * other effects, the view model's breathing) at time 0, so two captures of the
 * same pose match. Gameplay and networking run as normal.
 */
function debugFreeze(): void {
  if (new URLSearchParams(location.search).has('freeze')) freezeVisuals();
}

boot().catch((error: unknown) => {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  if (window.__ironvale) window.__ironvale.error = message;
  const notice = document.createElement('p');
  notice.textContent = `Ironvale could not start: ${message}`;
  notice.style.cssText = 'position:fixed;inset:auto 0 0 0;margin:0;padding:16px;color:#f7f5ef;font:14px system-ui;background:#0e0e0d';
  document.body.append(notice);
});
