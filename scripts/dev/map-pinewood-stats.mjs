// Lists the heaviest meshes in the loaded Pinewood scene (triangles x instances) and any failed requests.
// Usage: node scripts/dev/map-pinewood-stats.mjs [--q high]
import { chromium } from 'playwright';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const quality = arg('q', '');
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('response', (response) => {
  if (response.status() >= 400) process.stdout.write(`HTTP ${response.status()} ${response.url()}\n`);
});
page.on('pageerror', (error) => process.stdout.write(`[pageerror] ${error.message}\n`));
page.on('requestfailed', (request) => process.stdout.write(`request failed ${request.url()}\n`));
page.on('console', (message) => {
  if (message.type() !== 'error' && message.type() !== 'warning') return;
  const where = message.location();
  process.stdout.write(`[${message.type()}] ${message.text().slice(0, 200)} @ ${where.url}:${where.lineNumber}\n`);
});
const collect = () =>
  page.evaluate(() => {
    const out = [];
    window.__ironvale.game.map.root.traverse((object) => {
      if (!object.isMesh) return;
      const geometry = object.geometry;
      const triangles = (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
      const instances = object.isInstancedMesh ? object.count : 1;
      out.push({
        material: object.material.name || object.material.type,
        map: object.material.map?.source?.data?.src?.split('/').slice(-2).join('/') ?? '',
        triangles,
        instances,
        total: triangles * instances,
        shadow: object.castShadow,
        visible: object.visible,
      });
    });
    return out.sort((a, b) => b.total - a.total);
  });
// Other agents' edits hot-reload the page, so retry until one pass runs on a settled page.
let rows = [];
for (let attempt = 1; attempt <= 6; attempt++) {
  try {
    if (attempt === 1) await page.goto(`http://127.0.0.1:5311/?autostart&map=pinewood&bots=0${quality ? `&q=${quality}` : ''}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ironvale?.error || (window.__ironvale?.ready && window.__ironvale.game.map), null, { timeout: 90000 });
    await page.waitForTimeout(1500);
    rows = await collect();
    break;
  } catch (error) {
    if (attempt === 6) throw error;
    await page.waitForTimeout(2000);
  }
}
const total = rows.reduce((sum, row) => sum + (row.visible ? row.total : 0), 0);
process.stdout.write(`meshes: ${rows.length}, triangles if all drawn once: ${total}\n`);
for (const row of rows.slice(0, 28)) process.stdout.write(`${JSON.stringify(row)}\n`);
await browser.close();
