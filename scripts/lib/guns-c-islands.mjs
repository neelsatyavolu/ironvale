// Splits a single-mesh gun into its connected pieces so moving parts can be
// lifted out by where they sit. Vertices are joined by position, so UV seams
// and hard edges do not break a piece apart.
import { compactPrimitive } from '@gltf-transform/functions';

const QUANTUM = 1e-5;

/**
 * Connected pieces of a primitive. Each has its triangle numbers and its
 * bounds in the primitive's own space.
 */
export function findIslands(primitive) {
  const position = primitive.getAttribute('POSITION');
  const indices = primitive.getIndices();
  const corners = indices ? indices.getCount() : position.getCount();
  const corner = (i) => (indices ? indices.getScalar(i) : i);

  // Vertices at the same place share one id.
  const welded = new Uint32Array(position.getCount());
  const seen = new Map();
  const p = [0, 0, 0];
  for (let i = 0; i < position.getCount(); i++) {
    position.getElement(i, p);
    const key = `${Math.round(p[0] / QUANTUM)},${Math.round(p[1] / QUANTUM)},${Math.round(p[2] / QUANTUM)}`;
    let id = seen.get(key);
    if (id === undefined) {
      id = seen.size;
      seen.set(key, id);
    }
    welded[i] = id;
  }

  const parent = new Uint32Array(seen.size).map((_, i) => i);
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  for (let i = 0; i < corners; i += 3) {
    const a = find(welded[corner(i)]);
    parent[find(welded[corner(i + 1)])] = a;
    parent[find(welded[corner(i + 2)])] = a;
  }

  const islands = new Map();
  for (let i = 0; i < corners; i += 3) {
    const rootId = find(welded[corner(i)]);
    let island = islands.get(rootId);
    if (!island) {
      island = { triangles: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      islands.set(rootId, island);
    }
    island.triangles.push(i / 3);
    for (let k = 0; k < 3; k++) {
      position.getElement(corner(i + k), p);
      for (let axis = 0; axis < 3; axis++) {
        island.min[axis] = Math.min(island.min[axis], p[axis]);
        island.max[axis] = Math.max(island.max[axis], p[axis]);
      }
    }
  }
  return [...islands.values()];
}

/**
 * Cut the islands that `wanted(island)` accepts out of `primitive`. Returns a
 * new primitive holding them (null when none match); `primitive` keeps the rest.
 */
export function extractIslands(doc, primitive, wanted) {
  const indices = primitive.getIndices();
  const corner = (i) => (indices ? indices.getScalar(i) : i);
  const taken = [];
  const kept = [];
  for (const island of findIslands(primitive)) {
    const target = wanted(island) ? taken : kept;
    for (const triangle of island.triangles) target.push(corner(triangle * 3), corner(triangle * 3 + 1), corner(triangle * 3 + 2));
  }
  if (taken.length === 0) return null;
  const buffer = doc.getRoot().listBuffers()[0];
  const accessor = (values) => doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(values)).setBuffer(buffer);
  const part = primitive.clone();
  for (const semantic of primitive.listSemantics()) part.setAttribute(semantic, primitive.getAttribute(semantic).clone());
  part.setIndices(accessor(taken));
  primitive.setIndices(accessor(kept));
  compactPrimitive(part);
  compactPrimitive(primitive);
  return part;
}
