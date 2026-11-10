import * as THREE from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import type { TextureTier } from './settings';

export type AssetKind = 'hdri' | 'pbr' | 'model' | 'sound' | 'texture';

export interface AssetFile {
  /** Where `npm run assets` downloads the file from. Omitted for files committed to the repo. */
  readonly url?: string;
  /**
   * Location under public/assets/dl once fetched, or under public/assets/local
   * when `local` is true (processed files that are committed to the repo).
   */
  readonly path: string;
  readonly local?: boolean;
}

/**
 * One downloadable asset. `files` is keyed by role, optionally with a tier
 * suffix: `hdr@1k`, `sky` (optional 8k tone-mapped JPG panorama), `color@2k`, `normal@1k`, `arm@1k`, `rough@1k`, `ao@1k`,
 * `gltf`, `audio`. Extra files a glTF references use any other key and must
 * sit beside it on disk.
 */
export interface AssetEntry {
  readonly id: string;
  readonly kind: AssetKind;
  readonly license: string;
  readonly source: string;
  /** Attribution line, required for CC-BY assets. Shown on the credits screen. */
  readonly credit?: string;
  readonly files: Readonly<Record<string, AssetFile>>;
}

export interface PbrMaps {
  readonly color: THREE.Texture;
  readonly normal: THREE.Texture | null;
  /** Packed ambient occlusion (R), roughness (G), metalness (B). */
  readonly arm: THREE.Texture | null;
  readonly roughness: THREE.Texture | null;
  readonly ao: THREE.Texture | null;
}

const DOWNLOAD_ROOT = `${import.meta.env.BASE_URL}assets/dl/`;
const LOCAL_ROOT = `${import.meta.env.BASE_URL}assets/local/`;

function fileUrl(file: AssetFile): string {
  return (file.local ? LOCAL_ROOT : DOWNLOAD_ROOT) + file.path;
}
/** Every assets/*.json file is a manifest; they are merged. Ids must be unique across files. */
const MANIFEST_FILES = import.meta.glob<{ assets: AssetEntry[] }>('../../assets/*.json', {
  eager: true,
  import: 'default',
});
const MANIFEST = Object.values(MANIFEST_FILES).flatMap((file) => file.assets);

export type ProgressCallback = (loaded: number, total: number, id: string) => void;

/**
 * Loads and caches assets listed in assets/manifest.json. Call `preload` with
 * the ids a map or weapon needs, then read them synchronously with the typed
 * getters.
 */
export class Assets {
  private readonly entries = new Map<string, AssetEntry>(MANIFEST.map((entry) => [entry.id, entry]));
  private readonly hdris = new Map<string, THREE.Texture>();
  private readonly skies = new Map<string, THREE.Texture>();
  private readonly pbrs = new Map<string, PbrMaps>();
  private readonly models = new Map<string, GLTF>();
  private readonly sounds = new Map<string, ArrayBuffer>();
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly textureLoader = new THREE.TextureLoader();
  private readonly gltfLoader = new GLTFLoader();
  private readonly hdrLoader = new HDRLoader();

  constructor(
    private tier: TextureTier,
    private anisotropy: number,
    /** Sky panoramas wider than this are scaled down when loaded. */
    private skyMaxWidth = 4096,
  ) {}

  /** Every manifest entry, for the credits screen. */
  get manifest(): readonly AssetEntry[] {
    return [...this.entries.values()];
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Ids in the manifest whose id starts with `prefix`. */
  idsWithPrefix(prefix: string): string[] {
    return [...this.entries.keys()].filter((id) => id.startsWith(prefix));
  }

  async preload(ids: readonly string[], onProgress?: ProgressCallback): Promise<void> {
    const unique = [...new Set(ids)];
    let loaded = 0;
    await Promise.all(
      unique.map(async (id) => {
        await this.load(id);
        loaded++;
        onProgress?.(loaded, unique.length, id);
      }),
    );
  }

  hdri(id: string): THREE.Texture {
    return this.require(this.hdris, id);
  }

  /**
   * High-resolution tone-mapped panorama for the visible sky, when the manifest
   * entry has a `sky` file and the texture tier is 2k. The HDR stays in charge
   * of lighting; this only replaces what the player sees behind the level.
   */
  sky(id: string): THREE.Texture | null {
    return this.skies.get(id) ?? null;
  }

  pbr(id: string): PbrMaps {
    return this.require(this.pbrs, id);
  }

  /** A fresh clone of the model's scene; geometry and materials are shared. */
  model(id: string): THREE.Group {
    return this.require(this.models, id).scene.clone(true);
  }

  gltf(id: string): GLTF {
    return this.require(this.models, id);
  }

  sound(id: string): ArrayBuffer {
    return this.require(this.sounds, id);
  }

  texture(id: string): THREE.Texture {
    return this.require(this.textures, id);
  }

  private require<T>(cache: Map<string, T>, id: string): T {
    const value = cache.get(id);
    if (value === undefined) throw new Error(`Asset "${id}" was read before it was preloaded`);
    return value;
  }

  private load(id: string): Promise<void> {
    const existing = this.inFlight.get(id);
    if (existing) return existing;
    const entry = this.entries.get(id);
    if (!entry) return Promise.reject(new Error(`Asset "${id}" is not in assets/manifest.json`));
    const task = this.loadEntry(entry).catch((error: unknown) => {
      this.inFlight.delete(id);
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not load asset "${id}": ${reason}. Run "npm run assets" to fetch files.`);
    });
    this.inFlight.set(id, task);
    return task;
  }

  private async loadEntry(entry: AssetEntry): Promise<void> {
    switch (entry.kind) {
      case 'hdri': {
        const texture = await this.hdrLoader.loadAsync(this.url(entry, 'hdr'));
        texture.mapping = THREE.EquirectangularReflectionMapping;
        this.hdris.set(entry.id, texture);
        const skyFile = this.tier === '2k' ? entry.files.sky : undefined;
        if (skyFile) {
          const sky = await this.loadSky(fileUrl(skyFile));
          sky.colorSpace = THREE.SRGBColorSpace;
          sky.mapping = THREE.EquirectangularReflectionMapping;
          this.skies.set(entry.id, sky);
        }
        return;
      }
      case 'pbr': {
        const [color, normal, arm, roughness, ao] = await Promise.all([
          this.loadMap(entry, 'color', true),
          this.loadMap(entry, 'normal', false),
          this.loadMap(entry, 'arm', false),
          this.loadMap(entry, 'rough', false),
          this.loadMap(entry, 'ao', false),
        ]);
        if (!color) throw new Error('missing color map');
        this.pbrs.set(entry.id, { color, normal, arm, roughness, ao });
        return;
      }
      case 'texture': {
        const texture = await this.loadMap(entry, 'color', true);
        if (!texture) throw new Error('missing color file');
        this.textures.set(entry.id, texture);
        return;
      }
      case 'model': {
        this.models.set(entry.id, await this.gltfLoader.loadAsync(this.url(entry, 'gltf')));
        return;
      }
      case 'sound': {
        const response = await fetch(this.url(entry, 'audio'));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.sounds.set(entry.id, await response.arrayBuffer());
        return;
      }
    }
  }

  /** Load a panorama, scaling it down to `skyMaxWidth` to save GPU memory. */
  private async loadSky(url: string): Promise<THREE.Texture> {
    const texture = await this.textureLoader.loadAsync(url);
    const image = texture.image as HTMLImageElement;
    if (image.width <= this.skyMaxWidth || typeof createImageBitmap !== 'function') return texture;
    const scale = this.skyMaxWidth / image.width;
    const bitmap = await createImageBitmap(image, {
      resizeWidth: this.skyMaxWidth,
      resizeHeight: Math.round(image.height * scale),
      resizeQuality: 'high',
      imageOrientation: 'flipY',
    });
    texture.dispose();
    const scaled = new THREE.Texture(bitmap);
    // The bitmap is already flipped; flipping again on upload is not supported for bitmaps.
    scaled.flipY = false;
    scaled.needsUpdate = true;
    return scaled;
  }

  private async loadMap(entry: AssetEntry, role: string, srgb: boolean): Promise<THREE.Texture | null> {
    const file = this.file(entry, role);
    if (!file) return null;
    const texture = await this.textureLoader.loadAsync(fileUrl(file));
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = this.anisotropy;
    return texture;
  }

  /** Pick the file for a role at the current tier, falling back to the other tier or an untiered key. */
  private file(entry: AssetEntry, role: string): AssetFile | null {
    const other: TextureTier = this.tier === '2k' ? '1k' : '2k';
    return entry.files[`${role}@${this.tier}`] ?? entry.files[`${role}@${other}`] ?? entry.files[role] ?? null;
  }

  private url(entry: AssetEntry, role: string): string {
    const file = this.file(entry, role);
    if (!file) throw new Error(`no "${role}" file in manifest`);
    return fileUrl(file);
  }
}
