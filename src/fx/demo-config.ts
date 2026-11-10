import type { WeaponClass } from '../game/contracts';
import type { Weather } from '../world/types';

/** Event demos that `&fxdemo=` can switch on. `rain` and `mist` are weather overrides instead. */
export const DEMO_NAMES = ['impacts', 'walls', 'gun', 'flash', 'tracers', 'casings', 'blood', 'nearmiss'] as const;
export type DemoName = (typeof DEMO_NAMES)[number];

const WEAPON_CLASSES: readonly WeaponClass[] = ['pistol', 'rifle', 'carbine', 'smg', 'shotgun', 'sniper', 'lmg'];
const MIN_TIME_SCALE = 0.02;
const MAX_TIME_SCALE = 4;

export interface DemoConfig {
  readonly names: ReadonlySet<DemoName>;
  /** Weather to show whatever the map says, or null to use the map's own. */
  readonly weather: Weather | null;
  /** Weapon class the `gun` demo fires. */
  readonly weaponClass: WeaponClass;
  /** Multiplier on the effect clock; below 1 is slow motion. */
  readonly timeScale: number;
}

/**
 * Developer switches read from the page URL:
 * `&fxdemo=impacts,gun,...|all|rain|mist` fires representative events near the camera,
 * `&fxweapon=shotgun` picks the weapon class for the `gun` demo, and
 * `&fxslow=0.1` slows every effect so short ones can be inspected.
 */
export function readDemoConfig(search: string): DemoConfig {
  const params = new URLSearchParams(search);
  const requested = (params.get('fxdemo') ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  const names = new Set<DemoName>();
  let weather: Weather | null = null;
  for (const name of requested) {
    if (name === 'all') for (const each of DEMO_NAMES) names.add(each);
    else if (name === 'rain' || name === 'mist') weather = name;
    else if ((DEMO_NAMES as readonly string[]).includes(name)) names.add(name as DemoName);
  }
  const weapon = params.get('fxweapon') as WeaponClass | null;
  const slow = Number(params.get('fxslow'));
  return {
    names,
    weather,
    weaponClass: weapon && WEAPON_CLASSES.includes(weapon) ? weapon : 'carbine',
    timeScale: Number.isFinite(slow) && slow > 0 ? Math.min(MAX_TIME_SCALE, Math.max(MIN_TIME_SCALE, slow)) : 1,
  };
}
