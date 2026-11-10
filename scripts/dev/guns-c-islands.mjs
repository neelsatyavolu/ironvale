// Lists the connected pieces of one node's mesh in gun space, to find moving parts in a single-mesh gun.
// Usage: node scripts/dev/guns-c-islands.mjs file.glb <node name regex> <scale> <yawDeg> [minTris] [ox,oy,oz]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { transformPrimitive } from '@gltf-transform/functions';
import { multiply, translation } from '../lib/guns-c-gltf.mjs';
import { findIslands } from '../lib/guns-c-islands.mjs';

const [file, pattern, scaleText = '1', yawText = '0', minText = '1', offsetText = '0,0,0'] = process.argv.slice(2);
const s = Number(scaleText);
const yaw = (Number(yawText) * Math.PI) / 180;
const c = Math.cos(yaw);
const n = Math.sin(yaw);
const toGun = multiply(translation(offsetText.split(',').map(Number)), [c * s, 0, -n * s, 0, 0, s, 0, 0, n * s, 0, c * s, 0, 0, 0, 0, 1]);
const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(file);
const f = (v) => v.map((x) => x.toFixed(4).padStart(8)).join(' ');
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh || !new RegExp(pattern).test(node.getName())) continue;
  mesh.listPrimitives().forEach((primitive, index) => {
    transformPrimitive(primitive, multiply(toGun, node.getWorldMatrix()));
    const islands = findIslands(primitive);
    process.stdout.write(`node "${node.getName()}" prim ${index}: ${islands.length} islands\n`);
    islands
      .map((island, id) => ({ id, ...island }))
      .filter((island) => island.triangles.length >= Number(minText))
      .sort((a, b) => a.min[2] - b.min[2])
      .forEach((island) => process.stdout.write(`  #${String(island.id).padStart(3)} tris=${String(island.triangles.length).padStart(5)} min=${f(island.min)} max=${f(island.max)}\n`));
  });
}
