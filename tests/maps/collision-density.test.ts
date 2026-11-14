import * as THREE from 'three/webgpu';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Assets } from '../../src/core/assets';
import { hashString, seededRandom } from '../../src/core/random';
import { loadMapModule, PLAYABLE_MAPS } from '../../src/maps/registry';
import type { Surface } from '../../src/world/types';
import { CollisionWorld } from '../../src/world/collision';

/** The graphics presets' detail densities (`core/settings.ts`). */
const DENSITIES = [0.35, 0.6, 0.85, 1] as const;

/** A collision world that also hashes (FNV-1a) every collider and boundary it is given, in order. */
class HashingWorld extends CollisionWorld {
  hash = 0x811c9dc5;
  colliders = 0;
  triangles = 0;

  override addCollider(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, surface: Surface): void {
    this.digest(`collider:${surface}`, geometry, matrix);
    this.colliders++;
    super.addCollider(geometry, matrix, surface);
  }

  override addBoundary(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): void {
    this.digest('boundary', geometry, matrix);
    super.addBoundary(geometry, matrix);
  }

  private digest(tag: string, geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): void {
    const source = geometry.index ? geometry.toNonIndexed() : geometry;
    const attr = source.getAttribute('position');
    const baked = new Float32Array(attr.count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < attr.count; i++) {
      v.fromBufferAttribute(attr, i).applyMatrix4(matrix);
      baked.set([v.x, v.y, v.z], i * 3);
    }
    if (source !== geometry) source.dispose();
    if (tag !== 'boundary') this.triangles += attr.count / 3;
    for (const byte of [...tag].map((c) => c.charCodeAt(0))) this.mix(byte);
    for (const byte of new Uint8Array(baked.buffer)) this.mix(byte);
  }

  private mix(byte: number): void {
    this.hash = Math.imul(this.hash ^ byte, 0x01000193) >>> 0;
  }
}

/** Stand-in assets: blank textures and a one-box model, enough to build any map without a GPU or downloads. */
function stubAssets(): Assets {
  const texture = (): THREE.Texture => new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
  const scene = (): THREE.Group => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardNodeMaterial()));
    return group;
  };
  const stub = {
    hdri: texture,
    sky: () => null,
    texture,
    pbr: () => ({ color: texture(), normal: texture(), arm: texture(), roughness: null, ao: null }),
    model: scene,
    gltf: () => ({ scene: scene(), scenes: [], animations: [], cameras: [], asset: {}, parser: null, userData: {} }),
    has: () => true,
  };
  return stub as unknown as Assets;
}

/** Just enough of `document` for the maps' canvas-drawn decals: a 2D context that draws nothing. */
function stubDocument(): void {
  const context = new Proxy({} as Record<string | symbol, unknown>, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === 'measureText') return (text: string) => ({ width: text.length * 10 });
      return () => undefined;
    },
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  });
  const createElement = (tag: string): unknown => {
    if (tag !== 'canvas') throw new Error(`stub document cannot create <${tag}>`);
    return { width: 0, height: 0, getContext: () => context };
  };
  vi.stubGlobal('document', { createElement });
}

beforeAll(stubDocument);
afterAll(() => {
  vi.unstubAllGlobals();
});

async function collisionHash(mapId: string, detailDensity: number): Promise<{ hash: number; colliders: number; triangles: number }> {
  const module = await loadMapModule(mapId);
  const world = new HashingWorld();
  const map = await module.build({ assets: stubAssets(), world, detailDensity, random: seededRandom(hashString(mapId)) });
  map.dispose();
  return { hash: world.hash, colliders: world.colliders, triangles: world.triangles };
}

describe('map collision does not depend on detail density', () => {
  for (const { id } of PLAYABLE_MAPS) {
    it(`${id} registers the same colliders at every preset`, async () => {
      const [reference, ...others] = await Promise.all(DENSITIES.map((density) => collisionHash(id, density)));
      expect(reference!.colliders).toBeGreaterThan(0);
      for (const other of others) expect(other).toEqual(reference);
      // Building a whole map four times takes a few seconds, more on a busy machine.
    }, 60_000);
  }
});
