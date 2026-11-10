// Counts what a built gun or the arms cost to draw: meshes (draw calls per pass), triangles and
// materials from the live scene in the model viewer, so parts built in code are included, and
// textures from the GLB itself (the tuned finishes sample some maps through shader nodes, where a
// walk over material slots misses them). Texture memory is RGBA8 with mipmaps.
// Usage: node scripts/dev/guns-c-cost.mjs m4a1 m249 arms
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
async function fileCost(id) {
  const file = join(root, 'public/assets/local/guns', `${id}.glb`);
  const sizes = (await io.read(file)).getRoot().listTextures().map((texture) => texture.getSize() ?? [0, 0]);
  const bytes = sizes.reduce((sum, [w, h]) => sum + w * h * 4 * (4 / 3), 0);
  const counts = new Map();
  for (const [w, h] of sizes) counts.set(`${w}x${h}`, (counts.get(`${w}x${h}`) ?? 0) + 1);
  return { textures: [...counts].map(([size, n]) => `${n} @ ${size}`).join(', '), textureMB: (bytes / 1048576).toFixed(1), fileMB: ((await stat(file)).size / 1e6).toFixed(2) };
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
for (const id of process.argv.slice(2)) {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  // The arms page also builds a gun; `gun=none` leaves the arms alone.
  await page.goto(`http://127.0.0.1:5311/?view=weapons/models/${id}&markers=0${id === 'arms' ? '&gun=none' : ''}`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 60000 });
  const cost = await page.evaluate(() => {
    const scene = window.__ironvale.game.engine.scene;
    const meshes = [];
    scene.traverse((object) => {
      // Skip the viewer's own floor.
      if (object.isMesh && object.geometry.type !== 'CircleGeometry') meshes.push(object);
    });
    const materials = new Set();
    let triangles = 0;
    let skinned = 0;
    for (const mesh of meshes) {
      const geometry = mesh.geometry;
      triangles += (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
      if (mesh.isSkinnedMesh) skinned++;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
    }
    return { meshes: meshes.length, skinned, triangles: Math.round(triangles), materials: materials.size, names: meshes.map((mesh) => mesh.name).join(',') };
  }).catch((error) => ({ error: error.message }));
  process.stdout.write(`${id}: ${JSON.stringify({ ...cost, ...(await fileCost(id)) })}${problems.length ? ` problems: ${problems.join(' | ')}` : ''}\n`);
  await page.close();
}
await browser.close();
