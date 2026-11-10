/**
 * Maps game things (weapons, surfaces, reload stages, ambience beds) to sound
 * ids in the manifest. Nothing here throws for a missing id: lookups return an
 * empty list and the engine skips the sound.
 */
import type { Assets } from '../core/assets';
import type { CasingKind, WeaponActionStage, WeaponClass, WeaponDef } from '../game/contracts';
import type { MapInstance, Surface } from '../world/types';

const EMPTY: readonly string[] = [];
const NUMBERED = /-\d+$/;
/** Prefixes that are loaded per map rather than for every match. */
const PER_MAP_PREFIXES = ['snd-amb-', 'snd-loop-', 'snd-oneshot-'];

export const RAIN_BED = 'snd-amb-rain';
export const RAIN_ROOF_BED = 'snd-amb-rain-roof';
export const INTERFACE_PREFIX = 'snd-ui-';

const CLASS_WEAPON: Readonly<Record<WeaponClass, string>> = {
  carbine: 'm4a1',
  rifle: 'm1garand',
  smg: 'mp5',
  shotgun: 'r870',
  sniper: 'm24',
  lmg: 'm249',
  pistol: 'm1911',
};

/** Other stages of the same weapon that can stand in for a stage it has no recording of. */
const STAGE_ALIASES: Readonly<Record<WeaponActionStage, readonly WeaponActionStage[]>> = {
  magOut: ['beltOpen'],
  magIn: ['clipInsert', 'shellInsert'],
  boltBack: ['boltLift', 'pumpBack'],
  boltForward: ['slideRelease', 'boltClose', 'pumpForward'],
  boltLift: ['boltBack'],
  boltClose: ['boltForward'],
  pumpBack: ['boltBack'],
  pumpForward: ['boltForward'],
  shellInsert: ['magIn', 'clipInsert'],
  clipInsert: ['magIn'],
  clipPing: [],
  beltOpen: ['magOut'],
  beltClose: ['magIn'],
  slideRelease: ['boltForward'],
};

/** The weapon whose recording of a stage is used when the firing weapon has none at all. */
const STAGE_OWNER: Readonly<Record<WeaponActionStage, string>> = {
  magOut: 'm4a1',
  magIn: 'm4a1',
  boltBack: 'm4a1',
  boltForward: 'm4a1',
  boltLift: 'm24',
  boltClose: 'm24',
  pumpBack: 'r870',
  pumpForward: 'r870',
  shellInsert: 'r870',
  clipInsert: 'm1garand',
  clipPing: 'm1garand',
  beltOpen: 'm249',
  beltClose: 'm249',
  slideRelease: 'm1911',
};

const STEP_SURFACE: Readonly<Record<Surface, string>> = {
  concrete: 'concrete', cobble: 'cobble', asphalt: 'asphalt', gravel: 'gravel', dirt: 'dirt', grass: 'grass',
  sand: 'sand', wood: 'wood', metal: 'metal', plaster: 'concrete', glass: 'concrete', water: 'water',
  foliage: 'grass', flesh: 'dirt',
};

const IMPACT_SURFACE: Readonly<Record<Surface, string>> = {
  concrete: 'concrete', cobble: 'concrete', asphalt: 'concrete', plaster: 'concrete', gravel: 'dirt', dirt: 'dirt',
  grass: 'dirt', sand: 'dirt', foliage: 'dirt', wood: 'wood', metal: 'metal', glass: 'glass', water: 'water',
  flesh: 'flesh',
};

const RICOCHET: ReadonlySet<Surface> = new Set<Surface>(['concrete', 'cobble', 'asphalt', 'metal']);
const SOFT_GROUND: ReadonlySet<Surface> = new Set<Surface>(['dirt', 'grass', 'sand', 'foliage', 'water']);

/** Sparse one-shots that belong with each bed. */
const BED_ONESHOTS: Readonly<Record<string, readonly string[]>> = {
  'snd-amb-harbor': ['snd-oneshot-gull', 'snd-oneshot-gull', 'snd-oneshot-creak', 'snd-oneshot-clang'],
  'snd-amb-forest': ['snd-oneshot-branch'],
  'snd-amb-industrial': ['snd-oneshot-clang', 'snd-oneshot-creak', 'snd-oneshot-fence'],
};

export class Catalog {
  private readonly groups = new Map<string, string[]>();
  private readonly known = new Set<string>();

  constructor(assets: Assets) {
    for (const id of assets.idsWithPrefix('snd-').sort()) {
      this.known.add(id);
      const group = id.replace(NUMBERED, '');
      const list = this.groups.get(group) ?? [];
      list.push(id);
      this.groups.set(group, list);
    }
  }

  has(id: string): boolean {
    return this.known.has(id);
  }

  /** Every take of a group (`snd-m4a1-shot` -> shot-1..n). Empty when there is none. */
  takes(group: string): readonly string[] {
    return this.groups.get(group) ?? EMPTY;
  }

  /** Weapon key whose sounds to use: the weapon's own, or its class stand-in. */
  weaponKey(weapon: WeaponDef): string {
    return this.groups.has(`snd-${weapon.id}-shot`) ? weapon.id : CLASS_WEAPON[weapon.weaponClass];
  }

  weaponGroup(weapon: WeaponDef, layer: 'shot' | 'tail' | 'dist' | 'dry' | 'mech'): string {
    return `snd-${this.weaponKey(weapon)}-${layer}`;
  }

  /** Group for a reload or cycling stage, falling back to a related stage, then another weapon. */
  actionGroup(weapon: WeaponDef, stage: WeaponActionStage): string | null {
    const key = this.weaponKey(weapon);
    const own = `snd-${key}-${stage}`;
    if (this.groups.has(own)) return own;
    for (const alias of STAGE_ALIASES[stage]) {
      const group = `snd-${key}-${alias}`;
      if (this.groups.has(group)) return group;
    }
    const shared = `snd-${STAGE_OWNER[stage]}-${stage}`;
    return this.groups.has(shared) ? shared : null;
  }

  stepGroup(surface: Surface, running: boolean): string {
    const base = `snd-step-${STEP_SURFACE[surface]}`;
    const wanted = `${base}-${running ? 'run' : 'walk'}`;
    return this.groups.has(wanted) ? wanted : `${base}-walk`;
  }

  impactGroup(surface: Surface): string {
    return `snd-impact-${IMPACT_SURFACE[surface]}`;
  }

  ricochets(surface: Surface): boolean {
    return RICOCHET.has(surface);
  }

  casingGroup(kind: CasingKind, surface: Surface): string {
    return `snd-casing-${kind}-${SOFT_GROUND.has(surface) ? 'soft' : 'hard'}`;
  }

  landGroup(surface: Surface): string {
    if (surface === 'wood') return 'snd-land-wood';
    if (surface === 'gravel') return 'snd-land-gravel';
    return SOFT_GROUND.has(surface) ? 'snd-land-soft' : 'snd-land-hard';
  }

  /** One-shot groups to scatter around the listener for the beds a map uses. */
  oneShotGroups(bedIds: readonly string[]): string[] {
    return bedIds.flatMap((id) => BED_ONESHOTS[id] ?? []).filter((group) => this.groups.has(group));
  }

  /** Beds a map plays: its own stereo layers, plus rain when the weather calls for it. */
  bedIds(map: MapInstance): string[] {
    const ids = map.ambience.filter((layer) => !layer.position).map((layer) => layer.sound);
    if (map.weather === 'rain' && !ids.includes(RAIN_BED)) ids.push(RAIN_BED);
    return ids;
  }

  /** Ids used in every match: weapons, impacts, footsteps, foley, voice, interface. */
  shared(): string[] {
    return [...this.known].filter((id) => !PER_MAP_PREFIXES.some((prefix) => id.startsWith(prefix)));
  }

  interfaceIds(): string[] {
    return [...this.known].filter((id) => id.startsWith(INTERFACE_PREFIX));
  }

  /** Everything to preload for a map. Ids that are not in the manifest are left out. */
  required(map: MapInstance): string[] {
    const beds = this.bedIds(map);
    const ids = [
      ...this.shared(),
      ...map.ambience.map((layer) => layer.sound),
      ...beds,
      ...(beds.includes(RAIN_BED) ? [RAIN_ROOF_BED] : []),
      ...this.oneShotGroups(beds).flatMap((group) => this.takes(group)),
    ];
    return [...new Set(ids)].filter((id) => this.known.has(id));
  }
}
