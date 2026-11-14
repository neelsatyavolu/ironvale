// map-export page entry. run.mjs loads native/Tools/map-export/index.html through Vite (so the
// web modules get their import.meta transforms) and drives the functions on window.__mapExport.
import { Assets } from '../../../../src/core/assets';
import { hashString, seededRandom } from '../../../../src/core/random';
import { loadMapModule, PLAYABLE_MAPS } from '../../../../src/maps/registry';
import { CollisionWorld } from '../../../../src/world/collision';
import type { MapInstance } from '../../../../src/world/types';
import { Vector3, type Box3 } from 'three/webgpu';
import type { WeaponId } from '../../../../src/weapons/models/api';
import { captureCollision, SURFACES } from './collision';
import { exportGun, GUN_IDS } from './guns';
import { json, sha256Hex, writeFile } from './io';
import { COUNTS, recordQueries } from './queries';
import { programTable } from './programs';
import { exportRender } from './render';

/** Every package is exported at full detail (PLAN.md 3.7, owner decision Q3). Other densities are
 *  exported only to check that collision does not depend on detail (M11, W1). */
const DETAIL_DENSITY = 1;

const box = (b: Box3) => ({ min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] });
const v3 = (v: Vector3) => [v.x, v.y, v.z];

function metaJson(id: string, name: string, tagline: string, assets: readonly string[], map: MapInstance, world: CollisionWorld, detailDensity: number, extra: Record<string, unknown>) {
  const l = map.lighting;
  return {
    format: 'ironvale-map-package',
    version: 1,
    id,
    name,
    tagline,
    playable: PLAYABLE_MAPS.some((m) => m.id === id),
    detailDensity,
    assets: [...assets],
    bounds: box(map.bounds),
    collisionBounds: box(world.bounds),
    spawns: {
      player: map.playerSpawns.map((s) => ({ position: v3(s.position), yaw: s.yaw })),
      enemy: map.enemySpawns.map((s) => ({ position: v3(s.position), yaw: s.yaw })),
    },
    weather: map.weather,
    reverb: map.reverb,
    interiors: map.interiors.map((z) => ({ ...box(z.box), reverb: z.reverb, ...(z.skyLight === undefined ? {} : { skyLight: z.skyLight }) })),
    ambience: map.ambience.map((a) => ({
      sound: a.sound,
      volume: a.volume,
      ...(a.position ? { position: v3(a.position) } : {}),
      ...(a.radius === undefined ? {} : { radius: a.radius }),
    })),
    lighting: {
      hdri: l.hdri,
      hdriRotation: l.hdriRotation,
      skyIntensity: l.skyIntensity,
      sunDirection: v3(l.sunDirection),
      sunColor: l.sunColor,
      sunIntensity: l.sunIntensity,
      fog: { ...l.fog },
      exposure: l.exposure,
      volumetric: l.volumetric,
      ...(l.shaftDensity === undefined ? {} : { shaftDensity: l.shaftDensity }),
      bloom: l.bloom,
    },
    surfaceTable: [...SURFACES],
    ...extra,
  };
}

/** Runs the map's per-frame hook with time frozen so time-budgeted bakes (harbor shade) finish. */
function settle(map: MapInstance): void {
  if (!map.update) return;
  const viewer = map.playerSpawns[0]?.position.clone() ?? new Vector3();
  for (let i = 0; i < 64; i++) map.update(0, 0, viewer);
}

async function exportMap(id: string, options: { sourceCommit: string; render: boolean; detailDensity?: number }) {
  const detailDensity = options.detailDensity ?? DETAIL_DENSITY;
  const module = await loadMapModule(id);
  const assets = new Assets('2k', 1);
  await assets.preload(module.meta.assets);
  const world = new CollisionWorld();
  const map = await module.build({ assets, world, detailDensity, random: seededRandom(hashString(id)) });
  world.build();

  const files = captureCollision(world);
  const both = new Uint8Array(files.collision.length + files.boundary.length);
  both.set(files.collision, 0);
  both.set(files.boundary, files.collision.length);
  const collisionSha256 = await sha256Hex(both);
  const queries = recordQueries(world, map, id);

  const meta = metaJson(id, module.meta.name, module.meta.tagline, module.meta.assets, map, world, detailDensity, {
    collision: { triangles: files.triangleCount, boundaryTriangles: files.boundaryTriangleCount },
    collisionSha256,
    fixtures: { file: 'fixtures/queries.bin', ...COUNTS },
    sourceCommit: options.sourceCommit,
  });
  await Promise.all([
    writeFile(`${id}/collision.bin`, files.collision),
    writeFile(`${id}/boundary.bin`, files.boundary),
    writeFile(`${id}/bvh.bin`, files.bvh),
    writeFile(`${id}/fixtures/queries.bin`, queries),
    writeFile(`${id}/meta.json`, json(meta)),
  ]);

  let render = null;
  if (options.render) {
    settle(map);
    // Reference materials are built on a fresh seeded stream so they never shift the map's own.
    const programs = programTable(id, { assets, world: new CollisionWorld(), detailDensity, random: seededRandom(hashString(id)) });
    render = await exportRender(map.root, id, `${id}/render`, programs);
  }
  map.dispose();
  return { id, collisionSha256, triangles: files.triangleCount, boundaryTriangles: files.boundaryTriangleCount, render };
}

async function exportGuns(ids: readonly string[]) {
  const assets = new Assets('2k', 1);
  const results: Record<string, unknown> = {};
  for (const id of ids) results[id] = await exportGun(id as WeaponId, assets, 'guns');
  return results;
}

declare global {
  interface Window {
    __mapExport?: {
      playable: readonly string[];
      guns: readonly string[];
      exportMap: typeof exportMap;
      exportGuns: typeof exportGuns;
    };
  }
}

window.__mapExport = { playable: PLAYABLE_MAPS.map((m) => m.id), guns: GUN_IDS, exportMap, exportGuns };
