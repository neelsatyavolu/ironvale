// Bakes a rigidly skinned gun (every vertex bound to one bone) into plain
// gun-space primitives, one per source primitive and bone, so the bones can
// become ordinary part nodes. Also holds the small shape builders the scripts
// use to add parts a source model lacks.
import { multiply } from './guns-c-gltf.mjs';

const point = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
function direction(m, n) {
  const d = [m[0] * n[0] + m[4] * n[1] + m[8] * n[2], m[1] * n[0] + m[5] * n[1] + m[9] * n[2], m[2] * n[0] + m[6] * n[1] + m[10] * n[2]];
  const length = Math.hypot(...d) || 1;
  return d.map((v) => v / length);
}

/** A primitive with positions, normals and triangle indices only. */
export function plainPrimitive(doc, material, positions, normals, corners) {
  const buffer = doc.getRoot().listBuffers()[0];
  const accessor = (type, values, Type = Float32Array) => doc.createAccessor().setType(type).setArray(new Type(values)).setBuffer(buffer);
  return doc
    .createPrimitive()
    .setMaterial(material)
    .setAttribute('POSITION', accessor('VEC3', positions))
    .setAttribute('NORMAL', accessor('VEC3', normals))
    .setIndices(accessor('SCALAR', corners, Uint32Array));
}

/**
 * Every skinned mesh of `doc` in its bind pose, moved into gun space by `toGun`
 * (source world space to gun space; rotation and uniform scale only). Returns
 * `{ joint, material, primitive }` records: `joint` and `material` are source
 * names. Texture coordinates are dropped: the models this is for carry none in use.
 */
export function bakeSkinned(doc, toGun) {
  const pieces = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    const skin = node.getSkin();
    if (!mesh || !skin) continue;
    const joints = skin.listJoints();
    const inverseBind = skin.getInverseBindMatrices();
    const matrices = joints.map((joint, i) => multiply(toGun, multiply(joint.getWorldMatrix(), inverseBind.getElement(i, []))));
    for (const source of mesh.listPrimitives()) {
      const position = source.getAttribute('POSITION');
      const normal = source.getAttribute('NORMAL');
      const bones = source.getAttribute('JOINTS_0');
      const weights = source.getAttribute('WEIGHTS_0');
      const indices = source.getIndices();
      if (!normal || !bones || !weights || !indices) throw new Error(`Skinned mesh "${node.getName()}" lacks normals, bone weights or indices`);
      const boneOf = new Array(position.getCount());
      for (let i = 0; i < position.getCount(); i++) {
        const w = weights.getElement(i, []);
        const top = w.indexOf(Math.max(...w));
        if (w[top] < 0.99) throw new Error(`Mesh "${node.getName()}" is not rigidly skinned (vertex ${i} is blended)`);
        boneOf[i] = bones.getElement(i, [])[top];
      }
      // One output primitive per bone, with its own compact vertex list.
      const groups = new Map();
      for (let i = 0; i < indices.getCount(); i += 3) {
        const triangle = [indices.getScalar(i), indices.getScalar(i + 1), indices.getScalar(i + 2)];
        const bone = boneOf[triangle[0]];
        if (triangle.some((vertex) => boneOf[vertex] !== bone)) throw new Error(`Mesh "${node.getName()}" has a triangle shared between bones`);
        let group = groups.get(bone);
        if (!group) {
          group = { remap: new Map(), positions: [], normals: [], corners: [] };
          groups.set(bone, group);
        }
        for (const vertex of triangle) {
          let index = group.remap.get(vertex);
          if (index === undefined) {
            index = group.remap.size;
            group.remap.set(vertex, index);
            group.positions.push(...point(matrices[bone], position.getElement(vertex, [])));
            group.normals.push(...direction(matrices[bone], normal.getElement(vertex, [])));
          }
          group.corners.push(index);
        }
      }
      for (const [bone, group] of groups) {
        pieces.push({
          joint: joints[bone].getName(),
          material: source.getMaterial()?.getName() ?? '',
          primitive: plainPrimitive(doc, source.getMaterial(), group.positions, group.normals, group.corners),
        });
      }
    }
  }
  return pieces;
}

/** Moves every vertex of `primitive` through `map([x, y, z]) -> [x, y, z]`. Normals are left as they are. */
export function movePoints(primitive, map) {
  const position = primitive.getAttribute('POSITION');
  for (let i = 0; i < position.getCount(); i++) position.setElement(i, map(position.getElement(i, [])));
}

/** An axis-aligned box with flat faces. */
export function boxPrimitive(doc, material, min, max) {
  const positions = [];
  const normals = [];
  const corners = [];
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    for (const side of [-1, 1]) {
      const first = positions.length / 3;
      for (const [s, t] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        const corner = [0, 0, 0];
        corner[axis] = side < 0 ? min[axis] : max[axis];
        corner[u] = s ? max[u] : min[u];
        corner[v] = t ? max[v] : min[v];
        positions.push(...corner);
        normals.push(...[0, 1, 2].map((k) => (k === axis ? side : 0)));
      }
      // Counter-clockwise seen from outside.
      corners.push(...(side > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]).map((k) => first + k));
    }
  }
  return plainPrimitive(doc, material, positions, normals, corners);
}

/**
 * A surface of revolution about the line through `[cx, cy]` parallel to Z.
 * `profile` is a list of `[z, radius]` points running from the rear (+Z) to
 * the front; each span between two points is its own band with a hard edge.
 */
export function lathePrimitive(doc, material, [cx, cy], profile, segments) {
  const positions = [];
  const normals = [];
  const corners = [];
  for (let span = 0; span + 1 < profile.length; span++) {
    const [z0, r0] = profile[span];
    const [z1, r1] = profile[span + 1];
    const length = Math.hypot(z1 - z0, r1 - r0);
    if (length < 1e-9) continue;
    // Outward normal of a profile that runs toward -Z: radial part and Z part.
    const radial = -(z1 - z0) / length;
    const along = (r1 - r0) / length;
    const first = positions.length / 3;
    for (let step = 0; step <= segments; step++) {
      const angle = (step / segments) * Math.PI * 2;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      for (const [z, r] of [[z0, r0], [z1, r1]]) {
        positions.push(cx + r * c, cy + r * s, z);
        normals.push(radial * c, radial * s, along);
      }
    }
    for (let step = 0; step < segments; step++) {
      const a = first + step * 2;
      // a, a+1 on this meridian (rear, front); a+2, a+3 on the next.
      // A band that closes onto the axis at one end is a fan of single triangles.
      if (r1 > 1e-9) corners.push(a, a + 1, a + 3);
      if (r0 > 1e-9) corners.push(a, a + 3, a + 2);
    }
  }
  return plainPrimitive(doc, material, positions, normals, corners);
}
