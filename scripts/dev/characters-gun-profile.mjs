// Prints the cross-section of a gun GLB along its length (z), to place the soldier's hands on it.
// Usage: node scripts/dev/characters-gun-profile.mjs public/assets/local/guns/m4a1.glb
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(process.argv[2]);
const points = [];
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const m = node.getWorldMatrix();
  for (const primitive of mesh.listPrimitives()) {
    const positions = primitive.getAttribute('POSITION');
    for (let i = 0; i < positions.getCount(); i++) {
      const p = positions.getElement(i, []);
      points.push([m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14], node.getName()]);
    }
  }
}
const step = 0.03;
const minZ = Math.min(...points.map((p) => p[2]));
const maxZ = Math.max(...points.map((p) => p[2]));
for (let z = minZ; z < maxZ; z += step) {
  const slab = points.filter((p) => p[2] >= z && p[2] < z + step);
  if (slab.length === 0) continue;
  const range = (axis) => `${Math.min(...slab.map((p) => p[axis])).toFixed(3)}..${Math.max(...slab.map((p) => p[axis])).toFixed(3)}`;
  process.stdout.write(`z ${z.toFixed(2)}..${(z + step).toFixed(2)}  x ${range(0)}  y ${range(1)}  n=${slab.length} ${[...new Set(slab.map((p) => p[3]))].join(',')}\n`);
}
