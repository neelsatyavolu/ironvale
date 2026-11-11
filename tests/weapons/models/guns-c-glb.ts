import { NodeIO } from '@gltf-transform/core';
import { EXTTextureWebP, KHRMeshQuantization } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';

export type Point = readonly [number, number, number];
export type Axis = 0 | 1 | 2;

export interface Bounds {
  readonly min: number[];
  readonly max: number[];
  readonly count: number;
}

/** One connected piece of a node's mesh, in gun space. */
export interface Piece extends Bounds {
  readonly triangles: number;
}

export interface GunFile {
  readonly min: number[];
  readonly max: number[];
  readonly size: number[];
  readonly bytes: number;
  readonly triangles: number;
  readonly textureTypes: string[];
  readonly extensions: string[];
  readonly materials: string[];
  readonly parts: Map<string, { rotation: number[]; scale: number[]; translation: number[] }>;
  /** Vertices of one node (or of every node) in gun space. */
  points(node?: string): Point[];
  /** Bounds of the vertices of `node` inside the box `[x0, x1, y0, y1, z0, z1]`; null when none are. */
  within(node: string | undefined, box: readonly number[]): Bounds | null;
  /** Connected pieces of a node's mesh, joined by vertex position. */
  pieces(node: string): Piece[];
  /**
   * Where the line through `through` along `axis` crosses the surface of
   * `node`: the coordinates along that axis, ascending.
   */
  crossings(node: string, through: Point, axis: Axis): number[];
}

interface NodeMesh {
  readonly positions: Point[];
  /** Vertex numbers, three per triangle. */
  readonly corners: number[];
}

function bounds(points: readonly Point[]): Bounds | null {
  if (points.length === 0) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  }
  return { min, max, count: points.length };
}

function findPieces(mesh: NodeMesh): Piece[] {
  const ids = new Map<string, number>();
  const welded = mesh.positions.map((p) => {
    const key = p.map((value) => Math.round(value * 1e5)).join(',');
    const known = ids.get(key);
    if (known !== undefined) return known;
    ids.set(key, ids.size);
    return ids.size - 1;
  });
  const parent = Array.from({ length: ids.size }, (_, index) => index);
  const find = (start: number): number => {
    let at = start;
    while (parent[at] !== at) {
      parent[at] = parent[parent[at]];
      at = parent[at];
    }
    return at;
  };
  for (let i = 0; i < mesh.corners.length; i += 3) {
    const root = find(welded[mesh.corners[i]]);
    parent[find(welded[mesh.corners[i + 1]])] = root;
    parent[find(welded[mesh.corners[i + 2]])] = root;
  }
  const groups = new Map<number, Point[]>();
  for (let i = 0; i < mesh.corners.length; i += 3) {
    const root = find(welded[mesh.corners[i]]);
    const group = groups.get(root) ?? [];
    group.push(mesh.positions[mesh.corners[i]], mesh.positions[mesh.corners[i + 1]], mesh.positions[mesh.corners[i + 2]]);
    groups.set(root, group);
  }
  return [...groups.values()].map((group) => ({ ...(bounds(group) as Bounds), triangles: group.length / 3 }));
}

function findCrossings(mesh: NodeMesh, through: Point, axis: Axis): number[] {
  const u = ((axis + 1) % 3) as Axis;
  const v = ((axis + 2) % 3) as Axis;
  const hits: number[] = [];
  for (let i = 0; i < mesh.corners.length; i += 3) {
    const a = mesh.positions[mesh.corners[i]];
    const b = mesh.positions[mesh.corners[i + 1]];
    const c = mesh.positions[mesh.corners[i + 2]];
    // Barycentric coordinates of the line's point in the triangle's projection along the axis.
    const area = (b[u] - a[u]) * (c[v] - a[v]) - (c[u] - a[u]) * (b[v] - a[v]);
    if (Math.abs(area) < 1e-14) continue;
    const s = ((through[u] - a[u]) * (c[v] - a[v]) - (c[u] - a[u]) * (through[v] - a[v])) / area;
    const t = ((b[u] - a[u]) * (through[v] - a[v]) - (through[u] - a[u]) * (b[v] - a[v])) / area;
    if (s < 0 || t < 0 || s + t > 1) continue;
    hits.push(a[axis] + s * (b[axis] - a[axis]) + t * (c[axis] - a[axis]));
  }
  return hits.sort((first, second) => first - second);
}

/** Reads a processed gun from public/assets/local/guns for the asset checks. */
export async function readGun(id: string): Promise<GunFile> {
  // Vitest runs from the project root.
  const io = new NodeIO().registerExtensions([EXTTextureWebP, KHRMeshQuantization]);
  const doc = await io.read(`public/assets/local/guns/${id}.glb`);
  const root = doc.getRoot();
  const { min, max } = getBounds(root.listScenes()[0]);
  let triangles = 0;
  const meshes = new Map<string, NodeMesh>();
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    const positions: Point[] = [];
    const corners: number[] = [];
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      if (!position) continue;
      const offset = positions.length;
      for (let i = 0; i < position.getCount(); i++) {
        const p = position.getElement(i, [0, 0, 0]);
        positions.push([
          m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
          m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
          m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
        ]);
      }
      const indices = primitive.getIndices();
      const count = indices ? indices.getCount() : position.getCount();
      for (let i = 0; i < count; i++) corners.push(offset + (indices ? indices.getScalar(i) : i));
      triangles += count / 3;
    }
    meshes.set(node.getName(), { positions, corners });
  }
  const meshOf = (node: string): NodeMesh => {
    const mesh = meshes.get(node);
    if (!mesh) throw new Error(`Gun "${id}" has no mesh node "${node}"`);
    return mesh;
  };
  const points = (node?: string): Point[] => (node === undefined ? [...meshes.values()].flatMap((mesh) => mesh.positions) : meshOf(node).positions);
  return {
    min: [...min],
    max: [...max],
    size: max.map((value, axis) => value - min[axis]),
    bytes: (await io.writeBinary(doc)).byteLength,
    triangles,
    textureTypes: root.listTextures().map((texture) => texture.getMimeType()),
    extensions: root.listExtensionsUsed().map((extension) => extension.extensionName),
    materials: root.listMaterials().map((material) => material.getName()),
    parts: new Map(
      root.listNodes().map((node) => [
        node.getName(),
        { rotation: [...node.getRotation()], scale: [...node.getScale()], translation: [...node.getTranslation()] },
      ]),
    ),
    points,
    within: (node, box) =>
      bounds(points(node).filter((p) => p[0] >= box[0] && p[0] <= box[1] && p[1] >= box[2] && p[1] <= box[3] && p[2] >= box[4] && p[2] <= box[5])),
    pieces: (node) => findPieces(meshOf(node)),
    crossings: (node, through, axis) => findCrossings(meshOf(node), through, axis),
  };
}

/** The muzzle crown: the ring of vertices at the very front of the gun. */
export function crown(gun: GunFile): { centre: Point; radius: number; z: number; count: number } {
  const ring = gun.points().filter((p) => p[2] <= gun.min[2] + 0.0003);
  const centre: Point = [
    ring.reduce((sum, p) => sum + p[0], 0) / ring.length,
    ring.reduce((sum, p) => sum + p[1], 0) / ring.length,
    gun.min[2],
  ];
  const radius = Math.max(...ring.map((p) => Math.hypot(p[0] - centre[0], p[1] - centre[1])));
  return { centre, radius, z: gun.min[2], count: ring.length };
}
