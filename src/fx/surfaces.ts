import type { Surface } from '../world/types';
import type { DecalKind } from './decal-sheet';

type Rgb = readonly [number, number, number];
export type Family = 'masonry' | 'metal' | 'wood' | 'soil' | 'water' | 'glass' | 'foliage' | 'none';

export interface SurfaceLook {
  readonly family: Family;
  /** Albedo of the dust cloud and of the solid debris. */
  readonly dust: Rgb;
  readonly debris: Rgb;
  /** Multiplier on how much dust the surface gives off. */
  readonly dustiness: number;
  readonly decal: DecalKind | null;
}

export const SURFACE_LOOKS: Readonly<Record<Surface, SurfaceLook>> = {
  concrete: { family: 'masonry', dust: [0.56, 0.55, 0.53], debris: [0.5, 0.49, 0.47], dustiness: 1, decal: 'masonry' },
  plaster: { family: 'masonry', dust: [0.8, 0.78, 0.73], debris: [0.82, 0.8, 0.75], dustiness: 1.35, decal: 'masonry' },
  asphalt: { family: 'masonry', dust: [0.3, 0.3, 0.31], debris: [0.1, 0.1, 0.11], dustiness: 0.7, decal: 'masonry' },
  cobble: { family: 'masonry', dust: [0.5, 0.47, 0.43], debris: [0.36, 0.34, 0.31], dustiness: 0.85, decal: 'masonry' },
  metal: { family: 'metal', dust: [0.45, 0.45, 0.47], debris: [0.3, 0.3, 0.32], dustiness: 0.3, decal: 'metal' },
  wood: { family: 'wood', dust: [0.62, 0.52, 0.38], debris: [0.72, 0.58, 0.36], dustiness: 0.6, decal: 'wood' },
  dirt: { family: 'soil', dust: [0.13, 0.1, 0.07], debris: [0.09, 0.065, 0.045], dustiness: 1, decal: 'soft' },
  gravel: { family: 'soil', dust: [0.38, 0.36, 0.33], debris: [0.3, 0.28, 0.26], dustiness: 1, decal: 'soft' },
  sand: { family: 'soil', dust: [0.7, 0.6, 0.42], debris: [0.62, 0.52, 0.36], dustiness: 1.3, decal: 'soft' },
  grass: { family: 'soil', dust: [0.14, 0.11, 0.07], debris: [0.15, 0.27, 0.08], dustiness: 0.8, decal: 'soft' },
  water: { family: 'water', dust: [0.85, 0.9, 0.95], debris: [0.9, 0.94, 1], dustiness: 1, decal: null },
  glass: { family: 'glass', dust: [0.9, 0.93, 0.95], debris: [0.82, 0.95, 1], dustiness: 0.4, decal: null },
  foliage: { family: 'foliage', dust: [0.3, 0.34, 0.2], debris: [0.18, 0.32, 0.08], dustiness: 0.2, decal: null },
  flesh: { family: 'none', dust: [0, 0, 0], debris: [0, 0, 0], dustiness: 0, decal: null },
};
