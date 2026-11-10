import type { Box3, BufferGeometry, Group, Matrix4, Object3D, Vector3 } from 'three/webgpu';

/** Physical surface kind. Drives footstep, impact sound, impact particles and decals. */
export type Surface =
  | 'concrete'
  | 'cobble'
  | 'asphalt'
  | 'gravel'
  | 'dirt'
  | 'grass'
  | 'sand'
  | 'wood'
  | 'metal'
  | 'plaster'
  | 'glass'
  | 'water'
  | 'foliage'
  | 'flesh';

export interface RayHit {
  readonly point: Vector3;
  readonly normal: Vector3;
  readonly distance: number;
  readonly surface: Surface;
}

export interface CapsuleMoveResult {
  /** Feet position after sliding along the world. */
  readonly position: Vector3;
  readonly onGround: boolean;
  /** Surface under the feet when grounded. */
  readonly groundSurface: Surface | null;
  /** Velocity after removing the component that pushed into walls or floor. */
  readonly velocity: Vector3;
}

/**
 * Static collision world backed by a single BVH. Maps register colliders while
 * loading, then `build()` is called once. All queries are in world space, metres,
 * Y up.
 */
export interface World {
  /** Register collision triangles. `matrix` is the world matrix to bake in. */
  addCollider(geometry: BufferGeometry, matrix: Matrix4, surface: Surface): void;
  /** Convenience: register every mesh under `root` with one surface. */
  addColliderObject(root: Object3D, surface: Surface): void;
  /**
   * Register triangles that stop bodies but not bullets or sight lines. Use for
   * the invisible limits of the playable area so shots do not hit thin air.
   */
  addBoundary(geometry: BufferGeometry, matrix: Matrix4): void;
  build(): void;
  raycast(origin: Vector3, direction: Vector3, maxDistance: number): RayHit | null;
  /** true when nothing solid lies between a and b. */
  lineOfSight(a: Vector3, b: Vector3): boolean;
  /**
   * Move an upright capsule (feet at `position`) by `velocity * dt` with gravity
   * already included in `velocity`, sliding along geometry and stepping over
   * small ledges.
   */
  moveCapsule(
    position: Vector3,
    velocity: Vector3,
    dt: number,
    radius: number,
    height: number,
  ): CapsuleMoveResult;
  /** true when an upright capsule with its feet at `position` touches nothing. */
  capsuleFits(position: Vector3, radius: number, height: number): boolean;
  /** Height of the ground below a point, or null when there is none within `maxDrop`. */
  groundHeight(x: number, z: number, fromY: number, maxDrop?: number): number | null;
  readonly bounds: Box3;
}

export interface SpawnPoint {
  readonly position: Vector3;
  /** Yaw in radians; 0 looks down -Z. */
  readonly yaw: number;
}

export interface FogSetup {
  readonly color: number;
  /** Exponential density. Typical outdoor values: 0.004 (clear) to 0.03 (thick mist). */
  readonly density: number;
  /** Colour the fog takes on when looking toward the sun. Omit for one colour everywhere. */
  readonly sunTint?: number;
  /** 0 - 1: how far the fog shifts to `sunTint` when looking straight at the sun. */
  readonly sunTintStrength?: number;
  /**
   * Makes fog thin out with height so it pools low. Fraction of density lost
   * per metre above `baseHeight` (0.05 halves it in about 14 m). 0 or omitted
   * is uniform fog.
   */
  readonly heightFalloff?: number;
  readonly baseHeight?: number;
}

export interface LightingSetup {
  /** Asset id of the equirectangular HDR sky. */
  readonly hdri: string;
  /** Rotate the sky around Y so its sun lines up with `sunDirection`. Radians. */
  readonly hdriRotation: number;
  readonly skyIntensity: number;
  /** Unit vector pointing from the scene toward the sun. */
  readonly sunDirection: Vector3;
  readonly sunColor: number;
  readonly sunIntensity: number;
  readonly fog: FogSetup;
  /** Exposure multiplier applied before tone mapping. */
  readonly exposure: number;
  /** Strength of volumetric light shafts, 0 - 1. */
  readonly volumetric: number;
  /**
   * Multiplies how much air the shafts light up (default 1). Raise it on maps
   * whose look depends on visible beams; too high washes the whole frame out.
   */
  readonly shaftDensity?: number;
  readonly bloom: number;
}

export type Weather = 'clear' | 'rain' | 'mist';

export type ReverbPreset = 'open-field' | 'forest' | 'street' | 'industrial' | 'interior';

export interface AmbienceLayer {
  /** Asset id of a looping sound. */
  readonly sound: string;
  readonly volume: number;
  /** When set, the loop is positional and plays from here; otherwise it is a stereo bed. */
  readonly position?: Vector3;
  readonly radius?: number;
}

/** Axis-aligned region where the player counts as indoors (changes reverb, rain and sky light). */
export interface InteriorZone {
  readonly box: Box3;
  readonly reverb: ReverbPreset;
  /**
   * Fraction of sky light that reaches the inside, 0 - 1 (default 0.45). While
   * the player is in the zone the engine dims image-based lighting to this, so
   * the gun, arms and anything else in the room stop glowing with outdoor light.
   */
  readonly skyLight?: number;
}

export interface MapInstance {
  readonly root: Group;
  /** Playable area. Bots and nav grid stay inside it. */
  readonly bounds: Box3;
  readonly playerSpawns: readonly SpawnPoint[];
  readonly enemySpawns: readonly SpawnPoint[];
  readonly lighting: LightingSetup;
  readonly weather: Weather;
  readonly reverb: ReverbPreset;
  readonly ambience: readonly AmbienceLayer[];
  readonly interiors: readonly InteriorZone[];
  /**
   * Per-frame hook for animated map elements (water, swaying cables, flickering
   * lamps). `viewer` is the camera position, for distance-based detail.
   */
  update?(dt: number, elapsed: number, viewer: Vector3): void;
  dispose(): void;
}

export interface MapMeta {
  readonly id: string;
  readonly name: string;
  readonly tagline: string;
  /** Asset ids that must be loaded before `build` runs. */
  readonly assets: readonly string[];
}
