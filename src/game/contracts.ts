/**
 * Shared contracts between subsystems. Every subsystem depends on these types
 * and on `GameContext`, never on another subsystem's concrete classes.
 *
 * Conventions: metres, seconds, radians, Y up, right-handed, yaw 0 looks down -Z.
 * Vectors passed in events are owned by the emitter and may be reused after the
 * handler returns: clone anything you keep.
 */
import type { Object3D, Vector3 } from 'three/webgpu';
import type { Assets } from '../core/assets';
import type { EventBus } from '../core/events';
import type { Input } from '../core/input';
import type { Difficulty, SettingsStore } from '../core/settings';
import type { NetLobby, NetSnapshot } from '../net/api';
import type { Engine } from '../render/engine';
import type { MapInstance, RayHit, ReverbPreset, Surface, World } from '../world/types';

// ---------------------------------------------------------------- combat

export type Team = 'alpha' | 'bravo';
export type HitZone = 'head' | 'torso' | 'limb';
export type CombatantKind = 'local' | 'bot' | 'remote';

export interface DamageInfo {
  readonly amount: number;
  readonly zone: HitZone;
  readonly attackerId: number;
  readonly weaponId: string;
  readonly point: Vector3;
  /** Direction the bullet was travelling. */
  readonly direction: Vector3;
}

export interface CombatantHit {
  readonly distance: number;
  readonly zone: HitZone;
  readonly point: Vector3;
}

/** Anything that can shoot and be shot: the local player, a bot, or a networked player. */
export interface Combatant {
  readonly id: number;
  readonly kind: CombatantKind;
  readonly team: Team;
  readonly name: string;
  readonly alive: boolean;
  /** 0 - 100. */
  readonly health: number;
  /** Feet position. Live reference; do not mutate. */
  readonly position: Vector3;
  readonly velocity: Vector3;
  readonly crouching: boolean;
  /** Writes the eye position into `target` and returns it. */
  eyePosition(target: Vector3): Vector3;
  /** Ray against this combatant's hit volumes. `direction` is unit length. */
  hitTest(origin: Vector3, direction: Vector3, maxDistance: number): CombatantHit | null;
  applyDamage(info: DamageInfo): void;
}

export interface ShotResult {
  /** World geometry hit, when that is what stopped the bullet. */
  readonly world: RayHit | null;
  /** Combatant hit, when that is what stopped the bullet. */
  readonly combatant: Combatant | null;
  readonly combatantHit: CombatantHit | null;
  /** Where the bullet stopped, or the point at max range. */
  readonly end: Vector3;
  readonly distance: number;
}

export interface CombatRegistry {
  /** Next free combatant id. */
  allocateId(): number;
  add(combatant: Combatant): void;
  remove(id: number): void;
  get(id: number): Combatant | undefined;
  all(): readonly Combatant[];
  /**
   * Living combatants on the other team. The list is cached and only valid
   * until the next frame: do not keep it or mutate it.
   */
  enemiesOf(team: Team): readonly Combatant[];
  /**
   * Nearest hit among world geometry and all living combatants except
   * `ignoreId`. Pass `ignoreTeam` to let bullets pass through that team (no
   * friendly fire).
   */
  raycast(origin: Vector3, direction: Vector3, maxDistance: number, ignoreId: number, ignoreTeam?: Team): ShotResult;
}

// ---------------------------------------------------------------- weapons

export type WeaponClass = 'pistol' | 'rifle' | 'carbine' | 'smg' | 'shotgun' | 'sniper' | 'lmg';
export type FireMode = 'semi' | 'auto' | 'bolt';
export type ReloadStyle = 'magazine' | 'belt';
export type CasingKind = 'pistol' | 'rifle' | 'shotgun';

/** A step in a reload or cycling animation. Audio and the view model key off these. */
export type WeaponActionStage =
  | 'magOut'
  | 'magIn'
  | 'boltBack'
  | 'boltForward'
  | 'boltLift'
  | 'boltClose'
  | 'shellInsert'
  | 'beltOpen'
  | 'beltClose';

export interface RecoilProfile {
  /** Degrees of muzzle climb per shot. */
  readonly vertical: number;
  /** Maximum degrees of random sideways kick per shot. */
  readonly horizontal: number;
  /** Fraction of kick that returns to centre on its own (0 - 1). */
  readonly recovery: number;
  /** How hard the view model itself jolts back, in metres. */
  readonly kickback: number;
}

export interface WeaponDef {
  readonly id: string;
  readonly name: string;
  readonly weaponClass: WeaponClass;
  /** Loadout slot, 1 - 4. */
  readonly slot: number;
  readonly fireMode: FireMode;
  readonly roundsPerMinute: number;
  readonly damage: number;
  readonly headshotMultiplier: number;
  readonly limbMultiplier: number;
  /** Damage is full up to `falloffStart` metres and scales to `falloffMin` at `falloffEnd`. */
  readonly falloffStart: number;
  readonly falloffEnd: number;
  readonly falloffMin: number;
  readonly range: number;
  /** Metres per second. Sets tracer speed, hit delay at range and the sound of distant shots. */
  readonly muzzleVelocity: number;
  /** Projectiles per trigger pull (1 for every current gun). */
  readonly pellets: number;
  /** Cone half-angles in degrees. */
  readonly spreadHip: number;
  readonly spreadAim: number;
  readonly spreadMoving: number;
  readonly recoil: RecoilProfile;
  readonly magazineSize: number;
  readonly reserveAmmo: number;
  readonly reloadStyle: ReloadStyle;
  /** Seconds for a full reload. */
  readonly reloadTime: number;
  /** Seconds to raise the sights. */
  readonly aimTime: number;
  /** Field of view multiplier while aiming (0.8 irons, 0.25 for a 4x scope). */
  readonly aimZoom: number;
  /** Draws a full-screen scope overlay while aiming. */
  readonly scoped: boolean;
  /** Movement speed multiplier while this weapon is out. */
  readonly mobility: number;
  readonly casing: CasingKind;
  /** Sound loudness class; drives how far bots hear it. */
  readonly loudness: number;
}

/**
 * A first-person gun mesh. Built in code or loaded from glTF. Modelled with
 * the barrel along -Z, up +Y, origin at the pistol grip, real-world scale.
 */
export interface GunModel {
  readonly root: Object3D;
  /** Empty at the muzzle crown. Flash and tracers start here. */
  readonly muzzle: Object3D;
  /** Empty at the ejection port; its +X is the ejection direction. */
  readonly ejection: Object3D;
  /** Empty where the shooter's eye sits when aiming down the sights, looking down -Z. */
  readonly sight: Object3D;
  /** Named moving parts the view model animates. All optional. */
  readonly parts: {
    readonly bolt?: Object3D;
    readonly slide?: Object3D;
    readonly magazine?: Object3D;
    readonly trigger?: Object3D;
    readonly chargingHandle?: Object3D;
    readonly cover?: Object3D;
  };
  /** Local travel in metres along +Z for bolt or slide when cycled. */
  readonly cycleTravel: number;
  /**
   * Where the hands hold the gun. Each is an empty whose origin is the palm
   * centre, -Z along the fingers' forward direction and +Y toward the thumb side.
   * `support` is the off hand (fore-end or magazine well).
   */
  readonly grips: { readonly trigger: Object3D; readonly support: Object3D };
}

/** First-person arms that follow a gun's grip points. */
export interface ArmsRig {
  /** Add as a sibling of the gun under the view model root. */
  readonly root: Object3D;
  /**
   * Pose both arms so the hands sit on the given grips. Call every frame after
   * the gun has been animated. Pass null to tuck the support hand away (pistol
   * reloads, one-handed moments).
   */
  update(trigger: Object3D, support: Object3D | null): void;
  dispose(): void;
}

export interface WeaponState {
  readonly def: WeaponDef;
  readonly magazine: number;
  readonly reserve: number;
  readonly reloading: boolean;
}

/** Fires bullets for anyone. Bots and the player share it. */
export interface Ballistics {
  /**
   * Fire one trigger pull (all pellets). Applies spread, traces, applies damage,
   * and emits `shotFired`, `bulletTrace`, `bulletImpact` and `combatantHit`.
   * `spreadDegrees` overrides the weapon's own spread when given (bots use this
   * to model aim error).
   */
  fire(shooter: Combatant, weapon: WeaponDef, muzzle: Vector3, direction: Vector3, spreadDegrees?: number): void;
}

export interface PlayerWeapons {
  readonly current: WeaponState;
  readonly loadout: readonly WeaponState[];
  /** 0 at the hip, 1 fully aimed. */
  readonly aimBlend: number;
  /** Field of view multiplier to apply this frame. */
  readonly zoom: number;
  readonly scopedIn: boolean;
  equip(slot: number): void;
  /** Cone half-angle in degrees for a shot fired right now. Drives a spreading crosshair. */
  readonly spread: number;
  /** Scoped rifles: 1 with full lungs, 0 out of breath. */
  readonly breath: number;
  /** true when firing should break a sprint this frame. */
  readonly blocksSprint: boolean;
  /** Refill every weapon. Called on respawn. */
  resupply(): void;
  update(dt: number): void;
}

// ---------------------------------------------------------------- player

/** The local player's body: movement, camera and health. */
export interface PlayerBody extends Combatant {
  readonly yaw: number;
  readonly pitch: number;
  readonly onGround: boolean;
  readonly sprinting: boolean;
  /** Horizontal speed in m/s. */
  readonly speed: number;
  /** true while the player is under a roof (set from the map's interior zones). */
  readonly indoors: boolean;
  /** Radians the player's own hand turned the view this frame (no recoil, no assist). */
  readonly lookYaw: number;
  readonly lookPitch: number;
  /** Weapon systems set these each frame. `blockSprint` stops a sprint (firing, reloading). */
  setWeaponModifiers(modifiers: { mobility: number; aimBlend: number; zoom: number; blockSprint?: boolean }): void;
  /** Kick the view. Degrees. Part of it recovers on its own. */
  addRecoil(pitchDegrees: number, yawDegrees: number, recovery: number): void;
  /** Add an aim-assist turn for this frame, in radians. */
  nudgeView(yaw: number, pitch: number): void;
  respawn(position: Vector3, yaw: number): void;
}

// ---------------------------------------------------------------- events

export interface GameEvents {
  /** A trigger pull left the barrel. One event per pull, not per pellet. */
  shotFired: {
    shooterId: number;
    weapon: WeaponDef;
    muzzle: Vector3;
    direction: Vector3;
    /** true when the local player fired. */
    local: boolean;
  };
  /** One per projectile. `to` is the stop point. */
  bulletTrace: { shooterId: number; weapon: WeaponDef; from: Vector3; to: Vector3; local: boolean };
  /** A projectile hit world geometry. */
  bulletImpact: { shooterId: number; weapon: WeaponDef; hit: RayHit };
  /** A projectile hit a combatant. */
  combatantHit: {
    weapon: WeaponDef;
    targetId: number;
    attackerId: number;
    hit: CombatantHit;
    /** Direction the bullet was travelling. */
    direction: Vector3;
    fatal: boolean;
  };
  /** A bullet passed close to the local player without hitting. */
  nearMiss: { point: Vector3; direction: Vector3; weapon: WeaponDef };
  dryFire: { shooterId: number; weapon: WeaponDef; position: Vector3 };
  weaponAction: { shooterId: number; weapon: WeaponDef; stage: WeaponActionStage; position: Vector3; local: boolean };
  weaponSwitch: { shooterId: number; weapon: WeaponDef; local: boolean };
  casingEjected: { kind: CasingKind; position: Vector3; velocity: Vector3 };
  /** A spent casing hit the ground for the first time. */
  casingLanded: { kind: CasingKind; position: Vector3; surface: Surface };
  aimChanged: { aiming: boolean; weapon: WeaponDef };
  footstep: { ownerId: number; position: Vector3; surface: Surface; running: boolean; local: boolean };
  jumped: { ownerId: number; position: Vector3; local: boolean };
  landed: { ownerId: number; position: Vector3; surface: Surface; speed: number; local: boolean };
  /** The local player took damage. `direction` points from the player toward the source. */
  playerHurt: { amount: number; health: number; direction: Vector3 };
  died: { victimId: number; killerId: number; weaponId: string; headshot: boolean };
  spawned: { combatantId: number };
  /** A bot called something out (spotted, reloading, hit). Audio may voice it. */
  botCallout: { botId: number; kind: 'spotted' | 'reloading' | 'hurt' | 'death'; position: Vector3 };
  matchState: MatchSnapshot;
}

// ---------------------------------------------------------------- audio

export interface PlaySoundOptions {
  readonly volume?: number;
  /** Playback rate multiplier. */
  readonly pitch?: number;
  /** Random +/- variation applied to pitch. */
  readonly pitchJitter?: number;
  /** Distance at which the sound is at full volume. */
  readonly refDistance?: number;
  readonly maxDistance?: number;
  readonly loop?: boolean;
}

export interface SoundHandle {
  stop(fadeSeconds?: number): void;
  setVolume(volume: number): void;
}

/**
 * Spatial audio. Subscribes to `GameEvents` itself for gunfire, footsteps,
 * impacts and reloads; other systems only need `playAt`/`play` for one-offs.
 */
export interface AudioSystem {
  /** Must be called from a user gesture before any sound plays. */
  unlock(): Promise<void>;
  /** Asset ids of every sound that should be preloaded for a map. */
  requiredSounds(map: MapInstance): readonly string[];
  /** Decode preloaded sounds and start the map's ambience. */
  enterMap(map: MapInstance): Promise<void>;
  leaveMap(): void;
  playAt(soundId: string, position: Vector3, options?: PlaySoundOptions): SoundHandle;
  /** Non-positional (interface, the player's own gear). */
  play(soundId: string, options?: PlaySoundOptions): SoundHandle;
  setReverb(preset: ReverbPreset): void;
  setPaused(paused: boolean): void;
  update(dt: number): void;
  dispose(): void;
}

// ---------------------------------------------------------------- effects

/**
 * Visual effects. Subscribes to `GameEvents` itself for muzzle flashes,
 * tracers, impacts, decals, casings and blood.
 */
export interface EffectsSystem {
  enterMap(map: MapInstance): void;
  leaveMap(): void;
  update(dt: number): void;
  dispose(): void;
}

// ---------------------------------------------------------------- bots

export interface BotSystem {
  /** Build navigation data for the loaded map. */
  enterMap(map: MapInstance): Promise<void>;
  leaveMap(): void;
  spawn(count: number, team: Team, difficulty: Difficulty): void;
  /** Living bots. */
  readonly alive: number;
  update(dt: number): void;
  dispose(): void;
}

/** Third-person soldier body used for bots and remote players. */
export interface SoldierVisual {
  readonly root: Object3D;
  /** World-space muzzle position of the held weapon. */
  muzzleWorld(target: Vector3): Vector3;
  /**
   * Drive the pose. `speed` in m/s picks idle, walk or run; `aimPitch` tilts
   * the upper body; `firing` plays recoil.
   */
  setState(state: {
    speed: number;
    crouching: boolean;
    aimPitch: number;
    aiming: boolean;
    firing: boolean;
    reloading: boolean;
  }): void;
  /** Play a death fall in the direction the fatal bullet travelled. */
  die(direction: Vector3): void;
  /** Reset to a living pose for reuse. */
  revive(): void;
  flinch(zone: HitZone): void;
  update(dt: number): void;
  dispose(): void;
}

// ---------------------------------------------------------------- match

export type MatchMode = 'skirmish' | 'survival' | 'coop' | 'duel';
export type MatchPhase = 'menu' | 'loading' | 'playing' | 'paused' | 'won' | 'lost';

export interface MatchConfig {
  readonly mapId: string;
  readonly mode: MatchMode;
  readonly difficulty: Difficulty;
  /** Enemies alive at once. */
  readonly botCount: number;
  /** Co-op: which single-player rules the pair plays under. Skirmish when left out. */
  readonly rules?: 'skirmish' | 'survival';
  /** Duel: kills needed to win. */
  readonly killTarget?: number;
}

export interface KillFeedEntry {
  readonly killer: string;
  readonly victim: string;
  /** Display name of the weapon. */
  readonly weapon: string;
  readonly headshot: boolean;
  readonly time: number;
}

/** Everything the HUD and menus need. Emitted on `matchState` whenever it changes. */
export interface MatchSnapshot {
  readonly phase: MatchPhase;
  readonly config: MatchConfig | null;
  readonly loadingProgress: number;
  readonly loadingLabel: string;
  readonly health: number;
  readonly weaponName: string;
  readonly fireMode: FireMode | null;
  readonly magazine: number;
  readonly reserve: number;
  readonly reloading: boolean;
  readonly scopedIn: boolean;
  /** true while the sights are raised (aim blend past halfway). */
  readonly aiming: boolean;
  /** Lives left in Skirmish, including the current one. 1 in Survival. */
  readonly livesRemaining: number;
  /** Seconds until the player respawns; 0 while alive. */
  readonly respawnIn: number;
  /** Projectiles the local player has fired and landed on enemies this match. */
  readonly shotsFired: number;
  readonly shotsHit: number;
  readonly kills: number;
  readonly deaths: number;
  readonly enemiesRemaining: number;
  /** Survival mode wave number, 0 otherwise. */
  readonly wave: number;
  readonly elapsed: number;
  readonly killFeed: readonly KillFeedEntry[];
  /** Set while the loaded match is (or began as) a two-player match. */
  readonly net?: NetSnapshot | null;
}

/** Commands the interface can send to the game. */
export interface GameCommands {
  startMatch(config: MatchConfig): Promise<void>;
  resume(): void;
  pause(): void;
  restart(): Promise<void>;
  quitToMenu(): void;
  /** Maps that can be played, for the menu. */
  listMaps(): readonly { id: string; name: string; tagline: string; thumbnail?: string }[];
  /** Two-player lobby: host, join, set up and start a match with a friend. */
  readonly net: NetLobby;
}

// ---------------------------------------------------------------- context

/** Service locator handed to every subsystem. */
export interface GameContext {
  readonly engine: Engine;
  readonly settings: SettingsStore;
  readonly input: Input;
  readonly assets: Assets;
  readonly events: EventBus<GameEvents>;
  readonly world: World;
  readonly combat: CombatRegistry;
  /** The local player. */
  readonly player: PlayerBody;
  /** Set once each system is constructed; systems must not use these in their constructors. */
  readonly ballistics: Ballistics;
  /** The local player's guns. */
  readonly weapons: PlayerWeapons;
  readonly audio: AudioSystem;
  /** The map currently loaded, or null between matches. */
  readonly map: MapInstance | null;
  /** Seconds since the match started; stops while paused. */
  readonly time: number;
}

/** Signature every map module's default export must satisfy. */
export interface MapBuildContext {
  readonly assets: Assets;
  readonly world: World;
  /** 0 - 1 from graphics settings; scale instanced detail counts by this. */
  readonly detailDensity: number;
  /** Deterministic random in [0, 1) so a map looks the same on every load and for both network players. */
  random(): number;
}
