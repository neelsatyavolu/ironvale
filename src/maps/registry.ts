import type { MapBuildContext } from '../game/contracts';
import type { MapInstance, MapMeta } from '../world/types';

/** What every map module default-exports. */
export interface MapModule {
  readonly meta: MapMeta;
  /**
   * Build the scene graph, register colliders on `ctx.world` (do not call
   * `world.build()`; the game does) and return the instance. Assets listed in
   * `meta.assets` are already loaded.
   */
  build(ctx: MapBuildContext): MapInstance | Promise<MapInstance>;
}

type Loader = () => Promise<{ default: MapModule }>;

/** Maps are loaded on demand so a broken or heavy map never affects the others. */
const LOADERS: Readonly<Record<string, Loader>> = {
  range: () => import('./range/index'),
  harbor: () => import('./harbor/index'),
  pinewood: () => import('./pinewood/index'),
  railyard: () => import('./railyard/index'),
};

/** Shown in the menu, in this order. `range` is a developer test map and is left out. */
export const PLAYABLE_MAPS: readonly { id: string; name: string; tagline: string }[] = [
  { id: 'railyard', name: 'Railyard', tagline: 'Container yard in the rain at dusk' },
  { id: 'harbor', name: 'Harbor', tagline: 'Fishing town at golden hour' },
  { id: 'pinewood', name: 'Pinewood', tagline: 'Misty pine forest at dawn' },
];

export async function loadMapModule(id: string): Promise<MapModule> {
  const loader = LOADERS[id];
  if (!loader) throw new Error(`Unknown map "${id}"`);
  return (await loader()).default;
}
