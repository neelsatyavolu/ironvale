// Shared steps for scripts/process-gun-mp5.mjs.
//
// Each source GLB is rebuilt into one node per moving part: triangles are
// grouped into connected islands, a per-gun `assign` callback names the part
// each island belongs to (or drops it), and the geometry is baked into the
// game's gun space (metres, barrel along -Z, up +Y, origin at the pistol grip)
// relative to that part's pivot. Textures are resized and stored as WebP.
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import { dedup, prune, textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, '.cache', 'guns-a');
const OUT = join(ROOT, 'public', 'assets', 'local', 'guns');
const OBJAVERSE = 'https://huggingface.co/datasets/allenai/objaverse/resolve/main/glbs/';

export const flag = (name) => process.argv.includes(`--${name}`);

/** Download the source GLB into .cache/guns-a unless it is already there. */
export async function fetchSource(name, objaversePath) {
  const file = join(CACHE, name);
  try {
    await stat(file);
    return file;
  } catch {
    // not cached yet
  }
  const response = await fetch(OBJAVERSE + objaversePath);
  if (!response.ok) throw new Error(`Download of ${name} failed: HTTP ${response.status}`);
  await mkdir(CACHE, { recursive: true });
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

export async function readGlb(file) {
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).read(file);
}

// ---------------------------------------------------------------- matrices (column-major, like glTF)

export function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

/**
 * Uniform scale, then rotation about Y by `yawDeg`, then about X by
 * `pitchDeg` (positive lifts the muzzle), then translation.
 */
export function placement(scale, yawDeg, translation, pitchDeg = 0) {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  const cy = Math.cos(yaw) * scale;
  const sy = Math.sin(yaw) * scale;
  const rotateY = [cy, 0, -sy, 0, 0, scale, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1];
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const rotateX = [1, 0, 0, 0, 0, cp, sp, 0, 0, -sp, cp, 0, translation[0], translation[1], translation[2], 1];
  return multiply(rotateX, rotateY);
}

/**
 * Angle in degrees, in the YZ plane, of the long axis of a set of points:
 * 0 when it lies along Z, positive when it rises toward -Z (muzzle up).
 */
export function longAxisPitch(points) {
  let my = 0;
  let mz = 0;
  for (const p of points) {
    my += p[1];
    mz += p[2];
  }
  my /= points.length;
  mz /= points.length;
  let syy = 0;
  let szz = 0;
  let syz = 0;
  for (const p of points) {
    syy += (p[1] - my) ** 2;
    szz += (p[2] - mz) ** 2;
    syz += (p[1] - my) * (p[2] - mz);
  }
  // Principal axis of the 2x2 covariance; y falls as z grows when the muzzle is up.
  return (-0.5 * Math.atan2(2 * syz, szz - syy) * 180) / Math.PI;
}

const applyPoint = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

function applyDirection(m, x, y, z) {
  const dx = m[0] * x + m[4] * y + m[8] * z;
  const dy = m[1] * x + m[5] * y + m[9] * z;
  const dz = m[2] * x + m[6] * y + m[10] * z;
  const length = Math.hypot(dx, dy, dz) || 1;
  return [dx / length, dy / length, dz / length];
}

// ---------------------------------------------------------------- islands

/**
 * Split every primitive under the chosen nodes into connected islands, with
 * positions already moved into gun space by `toGun`.
 * Returns [{ node, material, prim, matrix, triangles: Uint32Array, min, max, centre, count }].
 */
export function findIslands(doc, toGun, selectNode = () => true) {
  const islands = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    // `selectNode` may return a matrix (source world space) to move a node before it is placed.
    const selected = selectNode(node);
    if (!selected) continue;
    const world = selected === true ? node.getWorldMatrix() : multiply(selected, node.getWorldMatrix());
    const matrix = multiply(toGun, world);
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute('POSITION');
      const indices = prim.getIndices();
      const vertexCount = position.getCount();
      const triCount = (indices ? indices.getCount() : vertexCount) / 3;
      const index = (i) => (indices ? indices.getScalar(i) : i);

      // Vertices that share a position belong together even when UV seams split them.
      const parent = new Uint32Array(vertexCount);
      const byPosition = new Map();
      const element = [];
      for (let i = 0; i < vertexCount; i++) {
        position.getElement(i, element);
        const key = `${Math.round(element[0] * 1e4)},${Math.round(element[1] * 1e4)},${Math.round(element[2] * 1e4)}`;
        const first = byPosition.get(key);
        if (first === undefined) byPosition.set(key, i);
        parent[i] = first ?? i;
      }
      const find = (i) => {
        while (parent[i] !== i) {
          parent[i] = parent[parent[i]];
          i = parent[i];
        }
        return i;
      };
      for (let t = 0; t < triCount; t++) {
        const a = find(index(t * 3));
        const b = find(index(t * 3 + 1));
        const c = find(index(t * 3 + 2));
        parent[b] = a;
        parent[c] = a;
      }
      const groups = new Map();
      for (let t = 0; t < triCount; t++) {
        const root = find(index(t * 3));
        const list = groups.get(root);
        if (list) list.push(t);
        else groups.set(root, [t]);
      }
      for (const triangles of groups.values()) {
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (const t of triangles) {
          for (let k = 0; k < 3; k++) {
            position.getElement(index(t * 3 + k), element);
            const p = applyPoint(matrix, element[0], element[1], element[2]);
            for (let a = 0; a < 3; a++) {
              if (p[a] < min[a]) min[a] = p[a];
              if (p[a] > max[a]) max[a] = p[a];
            }
          }
        }
        islands.push({
          node: node.getName(),
          material: prim.getMaterial()?.getName() ?? '',
          prim,
          matrix,
          triangles,
          min,
          max,
          centre: min.map((value, axis) => (value + max[axis]) / 2),
          count: triangles.length,
        });
      }
    }
  }
  return islands.sort((a, b) => b.count - a.count);
}

/** Every vertex of the given islands in gun space, as [x, y, z] (shared vertices repeat). */
export function pointsOf(islands) {
  const points = [];
  const element = [];
  for (const island of islands) {
    const position = island.prim.getAttribute('POSITION');
    const indices = island.prim.getIndices();
    for (const t of island.triangles) {
      for (let k = 0; k < 3; k++) {
        position.getElement(indices ? indices.getScalar(t * 3 + k) : t * 3 + k, element);
        points.push(applyPoint(island.matrix, element[0], element[1], element[2]));
      }
    }
  }
  return points;
}

/** Bounding box of a list of points: { min, max, centre }. */
export function boundsOf(points) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let a = 0; a < 3; a++) {
      if (p[a] < min[a]) min[a] = p[a];
      if (p[a] > max[a]) max[a] = p[a];
    }
  }
  return { min, max, centre: min.map((value, axis) => (value + max[axis]) / 2) };
}

/**
 * A copy of `island` moved by `offset` (metres, gun space), for parts the game
 * wants in a different position than the source file poses them in.
 */
export function moveIsland(island, offset) {
  const shift = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, offset[0], offset[1], offset[2], 1];
  const moved = (values) => values.map((value, axis) => value + offset[axis]);
  return { ...island, matrix: multiply(shift, island.matrix), min: moved(island.min), max: moved(island.max), centre: moved(island.centre) };
}

/**
 * Centre of the frontmost face of a barrel or flash hider: the middle of the
 * bounds of every point within `depth` of the lowest z. This is the crown,
 * where the bullet leaves, whatever lugs or flanges hang off the part behind it.
 */
export function crownCentre(points, depth = 0.001) {
  const front = Math.min(...points.map((p) => p[2]));
  const ring = boundsOf(points.filter((p) => p[2] <= front + depth));
  return [ring.centre[0], ring.centre[1], front];
}

const mm = (values) => values.map((value) => (value * 1000).toFixed(0).padStart(5)).join(' ');

/** Print islands (millimetres in gun space) so parts can be picked out by position. */
export function printIslands(islands, label = (island) => '') {
  islands.forEach((island, i) => {
    process.stdout.write(
      `${String(i).padStart(3)} tris=${String(island.count).padStart(5)} min[${mm(island.min)}] max[${mm(island.max)}] ${island.material} ${island.node} ${label(island)}\n`,
    );
  });
}

// ---------------------------------------------------------------- rebuild

/**
 * Replace the document's scene with one node per part.
 * `parts` maps part name -> pivot [x, y, z] in gun space; `assign(island)`
 * returns a part name or null to drop the island.
 */
export function rebuild(doc, islands, parts, assign) {
  const root = doc.getRoot();
  const buffer = root.listBuffers()[0];
  const buckets = new Map();
  for (const island of islands) {
    const part = assign(island);
    if (part === null) continue;
    if (!(part in parts)) throw new Error(`assign returned unknown part "${part}"`);
    const key = `${part}|${island.material}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { part, material: island.prim.getMaterial(), position: [], normal: [], tangent: [], uv: [], index: [], seen: new Map() };
      buckets.set(key, bucket);
    }
    const { prim, matrix } = island;
    const position = prim.getAttribute('POSITION');
    const normal = prim.getAttribute('NORMAL');
    const tangent = prim.getAttribute('TANGENT');
    const uv = prim.getAttribute('TEXCOORD_0');
    const indices = prim.getIndices();
    const pivot = parts[part];
    const element = [];
    let seen = bucket.seen.get(prim);
    if (!seen) {
      seen = new Map();
      bucket.seen.set(prim, seen);
    }
    for (const t of island.triangles) {
      for (let k = 0; k < 3; k++) {
        const source = indices ? indices.getScalar(t * 3 + k) : t * 3 + k;
        let target = seen.get(source);
        if (target === undefined) {
          target = bucket.position.length / 3;
          seen.set(source, target);
          position.getElement(source, element);
          const p = applyPoint(matrix, element[0], element[1], element[2]);
          bucket.position.push(p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]);
          if (normal) {
            normal.getElement(source, element);
            bucket.normal.push(...applyDirection(matrix, element[0], element[1], element[2]));
          }
          if (tangent) {
            tangent.getElement(source, element);
            bucket.tangent.push(...applyDirection(matrix, element[0], element[1], element[2]), element[3]);
          }
          if (uv) {
            uv.getElement(source, element);
            bucket.uv.push(element[0], element[1]);
          }
        }
        bucket.index.push(target);
      }
    }
  }

  const summary = [];
  for (const scene of root.listScenes()) scene.dispose();
  for (const item of [...root.listAnimations(), ...root.listSkins(), ...root.listNodes(), ...root.listMeshes()]) item.dispose();

  const scene = doc.createScene('gun');
  root.setDefaultScene(scene);
  const nodes = new Map();
  for (const bucket of buckets.values()) {
    let node = nodes.get(bucket.part);
    if (!node) {
      node = doc.createNode(bucket.part).setTranslation(parts[bucket.part]).setMesh(doc.createMesh(bucket.part));
      nodes.set(bucket.part, node);
      scene.addChild(node);
    }
    const accessor = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
    const vertexCount = bucket.position.length / 3;
    const prim = doc
      .createPrimitive()
      .setMaterial(bucket.material)
      .setAttribute('POSITION', accessor('VEC3', new Float32Array(bucket.position)))
      .setIndices(accessor('SCALAR', vertexCount > 65535 ? new Uint32Array(bucket.index) : new Uint16Array(bucket.index)));
    if (bucket.normal.length) prim.setAttribute('NORMAL', accessor('VEC3', new Float32Array(bucket.normal)));
    if (bucket.tangent.length) prim.setAttribute('TANGENT', accessor('VEC4', new Float32Array(bucket.tangent)));
    if (bucket.uv.length) prim.setAttribute('TEXCOORD_0', accessor('VEC2', new Float32Array(bucket.uv)));
    node.getMesh().addPrimitive(prim);
    summary.push({ part: bucket.part, material: bucket.material?.getName() ?? '', triangles: bucket.index.length / 3 });
  }
  return { scene, summary };
}

/** Prune, compress textures to WebP at `textureSize`, write the GLB and print what it holds. */
export async function writeGun(doc, id, summary, { textureSize = 1024, quality = 88 } = {}) {
  doc.createExtension(EXTTextureWebP).setRequired(true);
  // The game's gun materials have no emissive term, so a glow map would only be downloaded and decoded for nothing.
  for (const material of doc.getRoot().listMaterials()) material.setEmissiveTexture(null).setEmissiveFactor([0, 0, 0]);
  await doc.transform(
    prune({ keepLeaves: true }),
    dedup(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [textureSize, textureSize], quality }),
  );
  await mkdir(OUT, { recursive: true });
  const file = join(OUT, `${id}.glb`);
  await new NodeIO().registerExtensions(ALL_EXTENSIONS).write(file, doc);
  const { size } = await stat(file);
  let total = 0;
  for (const row of summary) {
    total += row.triangles;
    process.stdout.write(`${row.part.padEnd(16)} ${String(row.triangles).padStart(6)} tris  ${row.material}\n`);
  }
  process.stdout.write(`${file}: ${total} triangles, ${(size / 1024).toFixed(0)} KB\n`);
}
