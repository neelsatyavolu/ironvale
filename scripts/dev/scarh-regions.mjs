// Lists the SCAR-H source's connected pieces that fall in named regions (source units), to pick the parts processing removes or moves.
// Usage: node scripts/dev/scarh-regions.mjs
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { bakePrimitives, pick } from '../lib/guns-c-gltf.mjs';
import { findIslands } from '../lib/guns-c-islands.mjs';

const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read('.cache/guns-c/scarh/scarh-alexz.glb');
const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const f = (v) => v.map((x) => x.toFixed(2).padStart(7)).join('');
const regions = {
  sight: (c, i) => i.min[1] > 3.7 && c[2] > 1.9 && c[2] < 5.6,
  foregrip: (c, i) => c[2] > -8.2 && c[2] < -5.4 && i.max[1] < 1.3,
  magazine: (c, i) => c[2] > -1.4 && c[2] < 2.5 && i.max[1] < 1.3 && i.min[1] < -0.9,
  rightPort: (c, i) => i.max[0] > 0.6 && c[2] > -3 && c[2] < 4.5 && c[1] > 0.3,
  leftHandle: (c, i) => i.min[0] < -0.6 && c[2] > -6 && c[2] < 0 && c[1] > 1.5,
};
for (const name of ['Object_2', 'Object_3', 'Object_4', 'Object_5']) {
  const [primitive] = bakePrimitives(pick(doc, name), I);
  for (const island of findIslands(primitive)) {
    const c = [0, 1, 2].map((a) => (island.min[a] + island.max[a]) / 2);
    const hits = Object.entries(regions).filter(([, test]) => test(c, island)).map(([key]) => key);
    if (hits.length || name === 'Object_2') console.log(name.padEnd(9), String(island.triangles.length).padStart(5), 'c', f(c), 'min', f(island.min), 'max', f(island.max), hits.join(','));
  }
}
