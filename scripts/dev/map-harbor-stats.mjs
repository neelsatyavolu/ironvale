// Lists the meshes under the Harbor map root with their triangle counts, heaviest first.
// Usage: node scripts/dev/map-harbor-stats.mjs [--q high] [--top 25]
import { chromium } from 'playwright';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const tier = arg('q', 'high');
const top = Number(arg('top', '25'));
const port = arg('port', '5311');

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:${port}/?autostart&map=harbor&bots=0&q=${tier}&pose=48.5,0,13.2,90,0`, { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
const rows = await page.evaluate(() => {
  const root = window.__ironvale.game.engine.scene.getObjectByName('harbor');
  const out = [];
  root.traverse((child) => {
    if (!child.isMesh) return;
    const geometry = child.geometry;
    const perInstance = (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
    const instances = child.isInstancedMesh ? child.count : 1;
    const material = child.material;
    out.push({
      triangles: Math.round(perInstance * instances),
      perInstance: Math.round(perInstance),
      instances,
      shadow: child.castShadow,
      material: material.name || material.map?.name || `#${material.color?.getHexString?.() ?? '?'}`,
      name: child.name || child.parent?.name || '',
    });
  });
  return out.sort((a, b) => b.triangles - a.triangles);
});
await browser.close();
const total = rows.reduce((sum, row) => sum + row.triangles, 0);
const casting = rows.filter((row) => row.shadow).reduce((sum, row) => sum + row.triangles, 0);
process.stdout.write(`meshes: ${rows.length}, triangles: ${total}, shadow casters: ${casting}\n`);
for (const row of rows.slice(0, top)) {
  process.stdout.write(`${String(row.triangles).padStart(8)}  ${String(row.perInstance).padStart(7)} x${String(row.instances).padEnd(4)} ${row.shadow ? 'S' : '-'} ${row.material} ${row.name}\n`);
}
