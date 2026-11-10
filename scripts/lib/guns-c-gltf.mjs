// Shared glTF-Transform helpers for the guns-c processing scripts.
import { stat } from 'node:fs/promises';
import { joinPrimitives, transformPrimitive } from '@gltf-transform/functions';

/** Column-major 4x4 product a * b. */
export function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

export const translation = ([x, y, z]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
/** Half turn about Y: a model with its barrel along +Z ends up pointing down -Z. */
export const HALF_TURN_Y = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];

/** Rotation of `degrees` about Y with a uniform scale. 90 degrees takes +X to -Z. */
export function yawScale(degrees, scale) {
  const c = Math.cos((degrees * Math.PI) / 180) * scale;
  const s = Math.sin((degrees * Math.PI) / 180) * scale;
  return [c, 0, -s, 0, 0, scale, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

/**
 * Copies of every primitive under `nodes`, moved into gun space by `toGun`
 * (which maps source world space to gun space). Materials are kept.
 */
export function bakePrimitives(nodes, toGun) {
  const primitives = [];
  const visit = (node) => {
    const mesh = node.getMesh();
    if (mesh) {
      const matrix = multiply(toGun, node.getWorldMatrix());
      for (const source of mesh.listPrimitives()) {
        const copy = source.clone();
        for (const semantic of source.listSemantics()) copy.setAttribute(semantic, source.getAttribute(semantic).clone());
        if (source.getIndices()) copy.setIndices(source.getIndices().clone());
        transformPrimitive(copy, matrix);
        primitives.push(copy);
      }
    }
    node.listChildren().forEach(visit);
  };
  nodes.forEach(visit);
  return primitives;
}

/**
 * One new node with no rotation or scale from gun-space `primitives`, joined
 * per material. `pivot` is the node's origin in gun space, so the part can be
 * slid or hinged by animating that one node.
 */
export function partNode(doc, parent, name, primitives, pivot = [0, 0, 0]) {
  if (primitives.length === 0) throw new Error(`Part "${name}" has no geometry`);
  const byMaterial = new Map();
  for (const primitive of primitives) {
    transformPrimitive(primitive, translation(pivot.map((v) => -v)));
    const material = primitive.getMaterial();
    byMaterial.set(material, [...(byMaterial.get(material) ?? []), primitive]);
  }
  const mesh = doc.createMesh(name);
  for (const group of byMaterial.values()) mesh.addPrimitive(group.length === 1 ? group[0] : joinPrimitives(group));
  const part = doc.createNode(name).setMesh(mesh).setTranslation(pivot);
  parent.addChild(part);
  return part;
}

/** Merge the meshes of `nodes` (and everything under them) into one part node; see `partNode`. */
export function buildPart(doc, parent, name, nodes, toGun, pivot = [0, 0, 0]) {
  return partNode(doc, parent, name, bakePrimitives(nodes, toGun), pivot);
}

/** Look up source nodes by exact name; throws when one is missing so a changed download is noticed. */
export function pick(doc, ...names) {
  return names.map((name) => {
    const node = doc.getRoot().listNodes().find((candidate) => candidate.getName() === name);
    if (!node) throw new Error(`Source node "${name}" not found`);
    return node;
  });
}

/** Replace the scene content with one clean root and drop the source hierarchy. */
export function replaceScene(doc, root) {
  const scene = doc.getRoot().listScenes()[0];
  for (const child of scene.listChildren()) {
    if (child === root) continue;
    child.traverse((node) => node.setMesh(null));
    scene.removeChild(child);
    child.dispose();
  }
  if (!scene.listChildren().includes(root)) scene.addChild(root);
}

export async function report(file, doc) {
  let triangles = 0;
  for (const mesh of doc.getRoot().listMeshes())
    for (const primitive of mesh.listPrimitives()) triangles += (primitive.getIndices()?.getCount() ?? primitive.getAttribute('POSITION').getCount()) / 3;
  process.stdout.write(`${file}: ${triangles} triangles, ${((await stat(file)).size / 1e6).toFixed(2)} MB\n`);
}
