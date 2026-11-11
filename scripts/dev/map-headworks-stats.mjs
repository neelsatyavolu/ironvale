// Counts what Headworks costs to draw: meshes and triangles in the map, then the renderer's own
// draw-call and triangle counts for a frame at each pose in map-headworks-poses.json.
// Usage: node scripts/dev/map-headworks-stats.mjs [--q high] [--port 5311]
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const quality = arg('q', 'high');
const port = arg('port', '5311');
const poses = JSON.parse(await readFile(new URL('./map-headworks-poses.json', import.meta.url), 'utf8'));
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (error) => process.stdout.write(`[pageerror] ${error.message}\n`));

let first = true;
for (const [name, pose] of Object.entries(poses)) {
  await page.goto(`http://127.0.0.1:${port}/?autostart&map=headworks&bots=0&q=${quality}&pose=${pose}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ironvale?.error || (window.__ironvale?.ready && window.__ironvale.game.map), null, { timeout: 120000 });
  await page.waitForTimeout(2500);
  if (first) {
    first = false;
    const scene = await page.evaluate(() => {
      let meshes = 0;
      let triangles = 0;
      window.__ironvale.game.map.root.traverse((object) => {
        if (!object.isMesh) return;
        meshes++;
        const geometry = object.geometry;
        triangles += ((geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3) * (object.isInstancedMesh ? object.count : 1);
      });
      return { meshes, triangles: Math.round(triangles) };
    });
    process.stdout.write(`map: ${scene.meshes} meshes, ${scene.triangles} triangles in all\n`);
  }
  const frame = await page.evaluate(() => {
    const info = window.__ironvale.game.engine.renderer.info;
    return { drawCalls: info.render.drawCalls, triangles: info.render.triangles, frameMs: window.__ironvale.frameMs ?? null };
  });
  process.stdout.write(`${name.padEnd(12)} draw calls ${frame.drawCalls}, triangles ${frame.triangles}\n`);
}
await browser.close();
