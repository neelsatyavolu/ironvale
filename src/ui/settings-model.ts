import {
  graphicsForTier,
  QUALITY_PRESETS,
  type GraphicsSettings,
  type QualityTier,
} from '../core/settings';

export const TIERS: readonly QualityTier[] = ['low', 'medium', 'high', 'ultra'];

const TIER_NAMES: Readonly<Record<QualityTier, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  ultra: 'Ultra',
};

export function tierName(tier: QualityTier): string {
  return TIER_NAMES[tier];
}

function matches(graphics: GraphicsSettings, tier: QualityTier): boolean {
  const preset = QUALITY_PRESETS[tier];
  return (Object.keys(preset) as (keyof typeof preset)[]).every((key) => graphics[key] === preset[key]);
}

/**
 * The tier whose preset the settings equal, or null when the player has
 * changed something by hand. Frame rate and dynamic resolution are not part
 * of a preset, so they never make it custom.
 */
export function matchTier(graphics: GraphicsSettings): QualityTier | null {
  if (matches(graphics, graphics.tier)) return graphics.tier;
  return TIERS.find((tier) => matches(graphics, tier)) ?? null;
}

export function presetLabel(graphics: GraphicsSettings): string {
  const tier = matchTier(graphics);
  return tier ? TIER_NAMES[tier] : 'Custom';
}

/**
 * Change individual graphics fields. `tier` follows the values when they land
 * on a preset and otherwise stays where it was, because some passes pick
 * their sample counts from it.
 */
export function patchGraphics(graphics: GraphicsSettings, patch: Partial<Omit<GraphicsSettings, 'tier'>>): GraphicsSettings {
  const next: GraphicsSettings = { ...graphics, ...patch };
  const tier = matchTier(next);
  return tier && tier !== next.tier ? { ...next, tier } : next;
}

/** Switch to a preset, keeping the choices that are not part of one. */
export function applyTier(graphics: GraphicsSettings, tier: QualityTier): GraphicsSettings {
  return graphicsForTier(tier, graphics);
}
