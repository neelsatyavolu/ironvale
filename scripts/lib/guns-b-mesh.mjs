// Mesh helpers for the guns-b processing scripts (m1garand, m24). Texture helpers are in guns-b-texture.mjs.
// Everything here works on @gltf-transform documents in Node.
import { Primitive } from '@gltf-transform/core';

const WELD = 1e-5;
const VECTOR_SEMANTICS = ['POSITION', 'NORMAL', 'TANGENT'];

/** Column-major 4x4 for a uniform scale, a rotation about +Y (radians) and then a translation. */
export function canonicalMatrix({ scale = 1, yaw = 0, translate = [0, 0, 0] }) {
  const c = Math.cos(yaw) * scale;
  const s = Math.sin(yaw) * scale;
  return [c, 0, -s, 0, 0, scale, 0, 0, s, 0, c, 0, translate[0], translate[1], translate[2], 1];
}

export function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
  return out;
}

function applyPoint(m, v) {
  return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
}

function applyDirection(m, v) {
  const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2];
  const y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2];
  const z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2];
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

/**
 * Bakes every node's world transform, followed by `matrix`, into its vertices
 * and leaves all mesh nodes as direct children of the scene with identity
 * transforms. Assumes rotations and uniform scale only (no mirroring or shear).
 */
export function bakeScene(doc, matrix) {
  const scene = doc.getRoot().listScenes()[0];
  const done = new Set();
  const meshNodes = doc.getRoot().listNodes().filter((node) => node.getMesh());
  const worlds = new Map(meshNodes.map((node) => [node, multiply(matrix, node.getWorldMatrix())]));
  for (const node of meshNodes) {
    const world = worlds.get(node);
    for (const prim of node.getMesh().listPrimitives()) {
      for (const semantic of VECTOR_SEMANTICS) {
        const accessor = prim.getAttribute(semantic);
        if (!accessor) continue;
        if (done.has(accessor)) throw new Error(`${node.getName()}: ${semantic} accessor is shared between nodes`);
        done.add(accessor);
        // Bounds are stored as floats; integer-quantised sources would lose precision here.
        const size = accessor.getElementSize();
        const array = new Float32Array(accessor.getCount() * size);
        const element = [];
        for (let i = 0; i < accessor.getCount(); i++) {
          accessor.getElement(i, element);
          const moved = semantic === 'POSITION' ? applyPoint(world, element) : applyDirection(world, element);
          array.set(moved, i * size);
          if (size === 4) array[i * size + 3] = element[3];
        }
        accessor.setNormalized(false).setArray(array);
      }
    }
  }
  for (const node of meshNodes) {
    node.setMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    scene.addChild(node);
  }
  // Drop the now-empty transform nodes, innermost first.
  let removed = true;
  while (removed) {
    removed = false;
    for (const node of doc.getRoot().listNodes()) {
      if (node.getMesh() || node.listChildren().length > 0) continue;
      node.dispose();
      removed = true;
    }
  }
}

function triangleIndices(prim) {
  const indices = prim.getIndices();
  const count = indices ? indices.getCount() : prim.getAttribute('POSITION').getCount();
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) out[i] = indices ? indices.getScalar(i) : i;
  return out;
}

/**
 * Connected components of a triangle primitive, joining vertices that share a
 * position. Returns [{ triangles: number[], min, max, vertices: [x,y,z][] }]
 * in the primitive's own space.
 */
export function findIslands(prim) {
  const position = prim.getAttribute('POSITION');
  const vertexCount = position.getCount();
  const welded = new Uint32Array(vertexCount);
  const byKey = new Map();
  const points = new Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const p = position.getElement(i, []);
    points[i] = p;
    const key = `${Math.round(p[0] / WELD)},${Math.round(p[1] / WELD)},${Math.round(p[2] / WELD)}`;
    const existing = byKey.get(key);
    if (existing === undefined) byKey.set(key, i);
    welded[i] = existing ?? i;
  }
  const parent = new Uint32Array(vertexCount).map((_, i) => i);
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const indices = triangleIndices(prim);
  for (let t = 0; t < indices.length; t += 3) {
    const a = find(welded[indices[t]]);
    parent[find(welded[indices[t + 1]])] = a;
    parent[find(welded[indices[t + 2]])] = a;
  }
  const islands = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    const key = find(welded[indices[t]]);
    let island = islands.get(key);
    if (!island) {
      island = { triangles: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], vertices: [] };
      islands.set(key, island);
    }
    island.triangles.push(t / 3);
    for (let k = 0; k < 3; k++) {
      const p = points[indices[t + k]];
      island.vertices.push(p);
      for (let axis = 0; axis < 3; axis++) {
        island.min[axis] = Math.min(island.min[axis], p[axis]);
        island.max[axis] = Math.max(island.max[axis], p[axis]);
      }
    }
  }
  return [...islands.values()];
}

/** Islands whose bounds lie inside the box (with a small margin). Throws unless `count` match. */
export function islandsInBox(islands, min, max, count) {
  const margin = 5e-4;
  const found = islands.filter((island) =>
    [0, 1, 2].every((axis) => island.min[axis] >= min[axis] - margin && island.max[axis] <= max[axis] + margin),
  );
  if (count !== undefined && found.length !== count) {
    throw new Error(`expected ${count} islands in box ${min} .. ${max}, found ${found.length}`);
  }
  return found;
}

function buildPrimitive(doc, source, indices) {
  const remap = new Map();
  const order = [];
  const newIndices = new Uint32Array(indices.length);
  indices.forEach((vertex, i) => {
    let mapped = remap.get(vertex);
    if (mapped === undefined) {
      mapped = order.length;
      remap.set(vertex, mapped);
      order.push(vertex);
    }
    newIndices[i] = mapped;
  });
  const buffer = doc.getRoot().listBuffers()[0];
  const prim = doc.createPrimitive().setMode(Primitive.Mode.TRIANGLES).setMaterial(source.getMaterial());
  for (const semantic of source.listSemantics()) {
    const from = source.getAttribute(semantic);
    const size = from.getElementSize();
    const array = new (from.getArray().constructor)(order.length * size);
    const element = [];
    const to = doc.createAccessor().setType(from.getType()).setNormalized(from.getNormalized()).setArray(array).setBuffer(buffer);
    order.forEach((vertex, i) => to.setElement(i, from.getElement(vertex, element)));
    prim.setAttribute(semantic, to);
  }
  const indexArray = order.length > 65535 ? newIndices : new Uint16Array(newIndices);
  prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(indexArray).setBuffer(buffer));
  return prim;
}

/**
 * Splits `prim` (the only user of its mesh slot) in two: the given triangles go
 * to a new node named `name` under the scene, the rest stay in `node`. Both
 * get their own compact vertex buffers. Returns the new node.
 */
export function extractPart(doc, node, prim, triangles, name) {
  const picked = new Set(triangles);
  const indices = triangleIndices(prim);
  const keep = [];
  const move = [];
  for (let t = 0; t < indices.length; t += 3) {
    (picked.has(t / 3) ? move : keep).push(indices[t], indices[t + 1], indices[t + 2]);
  }
  if (move.length === 0) throw new Error(`no triangles selected for "${name}"`);
  const mesh = node.getMesh();
  const part = buildPrimitive(doc, prim, move);
  const rest = buildPrimitive(doc, prim, keep);
  mesh.removePrimitive(prim);
  mesh.addPrimitive(rest);
  prim.dispose();
  const partNode = doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(part));
  doc.getRoot().listScenes()[0].addChild(partNode);
  return { node: partNode, rest };
}

/** Moves a node's origin to `pivot` without moving its geometry (node must have identity rotation and scale). */
export function setPivot(node, pivot) {
  const [tx, ty, tz] = node.getTranslation();
  const delta = [pivot[0] - tx, pivot[1] - ty, pivot[2] - tz];
  const seen = new Set();
  for (const prim of node.getMesh().listPrimitives()) {
    const position = prim.getAttribute('POSITION');
    if (seen.has(position)) continue;
    seen.add(position);
    const element = [];
    for (let i = 0; i < position.getCount(); i++) {
      position.getElement(i, element);
      position.setElement(i, [element[0] - delta[0], element[1] - delta[1], element[2] - delta[2]]);
    }
  }
  node.setTranslation(pivot);
}

/** Translates a node's geometry (not its origin). */
export function shiftGeometry(node, offset) {
  const pivot = node.getTranslation();
  setPivot(node, [pivot[0] - offset[0], pivot[1] - offset[1], pivot[2] - offset[2]]);
  node.setTranslation(pivot);
}

export function countTriangles(doc) {
  let total = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) total += triangleIndices(prim).length / 3;
  }
  return total;
}

/** Finds a scene-level node by exact name or throws. */
export function nodeNamed(doc, name) {
  const node = doc.getRoot().listNodes().find((candidate) => candidate.getName() === name);
  if (!node) throw new Error(`node "${name}" not found`);
  return node;
}

/** Creates an empty parent at `pivot` and moves `children` under it, re-pivoted to the same point. */
export function groupAt(doc, name, pivot, children) {
  const group = doc.createNode(name).setTranslation(pivot);
  doc.getRoot().listScenes()[0].addChild(group);
  for (const child of children) {
    setPivot(child, pivot);
    child.setTranslation([0, 0, 0]);
    group.addChild(child);
  }
  return group;
}


/** Indices of the triangles of `prim` whose three corners all pass `inside([x, y, z])`. */
export function trianglesWhere(prim, inside) {
  const position = prim.getAttribute('POSITION');
  const indices = triangleIndices(prim);
  const point = [];
  const found = [];
  for (let t = 0; t < indices.length; t += 3) {
    let all = true;
    for (let k = 0; k < 3 && all; k++) all = inside(position.getElement(indices[t + k], point));
    if (all) found.push(t / 3);
  }
  return found;
}

/**
 * Replaces `nodes` (identity transforms, as left by `bakeScene`) with one node
 * named `name` whose mesh has a single primitive per material, so static parts
 * cost one draw call per material instead of one per source object.
 */
export function mergeNodes(doc, name, nodes) {
  const byMaterial = new Map();
  for (const node of nodes) {
    for (const prim of node.getMesh().listPrimitives()) {
      const list = byMaterial.get(prim.getMaterial()) ?? [];
      list.push(prim);
      byMaterial.set(prim.getMaterial(), list);
    }
  }
  const buffer = doc.getRoot().listBuffers()[0];
  const mesh = doc.createMesh(name);
  for (const [material, prims] of byMaterial) {
    const semantics = prims[0].listSemantics().filter((semantic) => prims.every((prim) => prim.getAttribute(semantic)));
    const vertexCount = prims.reduce((sum, prim) => sum + prim.getAttribute('POSITION').getCount(), 0);
    const merged = doc.createPrimitive().setMode(Primitive.Mode.TRIANGLES).setMaterial(material);
    for (const semantic of semantics) {
      const first = prims[0].getAttribute(semantic);
      const size = first.getElementSize();
      const array = new Float32Array(vertexCount * size);
      const element = [];
      let offset = 0;
      for (const prim of prims) {
        const from = prim.getAttribute(semantic);
        for (let i = 0; i < from.getCount(); i++) array.set(from.getElement(i, element), (offset + i) * size);
        offset += from.getCount();
      }
      merged.setAttribute(semantic, doc.createAccessor().setType(first.getType()).setArray(array).setBuffer(buffer));
    }
    const indices = [];
    let base = 0;
    for (const prim of prims) {
      for (const index of triangleIndices(prim)) indices.push(base + index);
      base += prim.getAttribute('POSITION').getCount();
    }
    const indexArray = vertexCount > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
    merged.setIndices(doc.createAccessor().setType('SCALAR').setArray(indexArray).setBuffer(buffer));
    mesh.addPrimitive(merged);
  }
  for (const node of nodes) {
    const old = node.getMesh();
    node.dispose();
    for (const prim of old.listPrimitives()) prim.dispose();
    old.dispose();
  }
  const joined = doc.createNode(name).setMesh(mesh);
  doc.getRoot().listScenes()[0].addChild(joined);
  return joined;
}

/** Mean position of the vertices of `prim` within `tolerance` of its extreme along `axis` (`sign` -1 for the minimum). */
export function endRingCentre(prim, axis, sign, tolerance = 1e-4) {
  const position = prim.getAttribute('POSITION');
  const point = [];
  let extreme = -Infinity;
  for (let i = 0; i < position.getCount(); i++) extreme = Math.max(extreme, position.getElement(i, point)[axis] * sign);
  const sum = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < position.getCount(); i++) {
    position.getElement(i, point);
    if (extreme - point[axis] * sign > tolerance) continue;
    for (let c = 0; c < 3; c++) sum[c] += point[c];
    count++;
  }
  return sum.map((value) => value / count);
}

/**
 * Stretches a primitive sideways about x = 0: |x| becomes `map(|x|, z)` with
 * the sign kept. `slope(|x|, z)` is the derivative of `map` in x; normals and
 * tangents are corrected with it so shading follows the new surface.
 */
export function stretchWidth(prim, map, slope) {
  const position = prim.getAttribute('POSITION');
  const normal = prim.getAttribute('NORMAL');
  const tangent = prim.getAttribute('TANGENT');
  const p = [];
  const v = [];
  for (let i = 0; i < position.getCount(); i++) {
    position.getElement(i, p);
    const stretch = slope(Math.abs(p[0]), p[2]);
    if (normal) {
      normal.getElement(i, v);
      const n = [v[0] / stretch, v[1], v[2]];
      const length = Math.hypot(...n) || 1;
      normal.setElement(i, n.map((value) => value / length));
    }
    if (tangent) {
      tangent.getElement(i, v);
      const t = [v[0] * stretch, v[1], v[2]];
      const length = Math.hypot(...t) || 1;
      tangent.setElement(i, [t[0] / length, t[1] / length, t[2] / length, v[3]]);
    }
    position.setElement(i, [Math.sign(p[0]) * map(Math.abs(p[0]), p[2]), p[1], p[2]]);
  }
}
