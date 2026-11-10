// Lists the connected mesh islands of every primitive in a glTF/GLB after an
// optional canonical transform, so moving parts can be picked out of a
// single-mesh gun, and prints cross-sections of one island.
// Usage: node scripts/dev/guns-b-islands.mjs <file> [--scale s] [--yaw deg] [--min tris]
//        [--slice node:prim:island:axis:from:to:step]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { bakeScene, canonicalMatrix, findIslands } from '../lib/guns-b-mesh.mjs';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(process.argv[2]);
bakeScene(doc, canonicalMatrix({ scale: Number(arg('scale', 1)), yaw: (Number(arg('yaw', 0)) * Math.PI) / 180 }));
const minTris = Number(arg('min', 1));
const slice = arg('slice', '').split(':');
const f = (v) => v.map((x) => x.toFixed(4).padStart(8)).join(' ');
for (const node of doc.getRoot().listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  mesh.listPrimitives().forEach((prim, index) => {
    const islands = findIslands(prim);
    console.log(`node "${node.getName()}" prim ${index}: ${islands.length} islands`);
    islands
      .map((island, id) => ({ id, ...island }))
      .filter((island) => island.triangles.length >= minTris)
      .sort((a, b) => a.min[2] - b.min[2])
      .forEach((island) => console.log(`  #${String(island.id).padStart(3)} tris=${String(island.triangles.length).padStart(5)} min=${f(island.min)} max=${f(island.max)}`));
    if (slice.length === 7 && node.getName().includes(slice[0]) && Number(slice[1]) === index) {
      const axis = Number(slice[3]);
      const island = islands[Number(slice[2])];
      if (!island) return;
      for (let at = Number(slice[4]); at <= Number(slice[5]) + 1e-9; at += Number(slice[6])) {
        const near = island.vertices.filter((p) => Math.abs(p[axis] - at) <= Number(slice[6]) / 2);
        if (near.length === 0) continue;
        const min = [0, 1, 2].map((k) => Math.min(...near.map((p) => p[k])));
        const max = [0, 1, 2].map((k) => Math.max(...near.map((p) => p[k])));
        console.log(`  slice axis${axis}=${at.toFixed(4)} n=${near.length} min=${f(min)} max=${f(max)}`);
      }
    }
  });
}
