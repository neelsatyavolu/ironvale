// Renders a menu thumbnail for each playable map from the running dev server.
// Usage: node scripts/dev/ui-thumbs.mjs [--maps railyard,harbor,headworks] [--out public/assets/thumbs] [--wait 4000]
//        [--pose-<id> "x,y,z,yawDeg,pitchDeg"]
// Writes <out>/<id>.jpg (640x360). A map that fails to load is skipped and reported.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const maps = arg('maps', 'railyard,harbor,headworks').split(',').filter(Boolean);
const out = join(root, arg('out', 'public/assets/thumbs'));
const wait = Number(arg('wait', '4000'));
const port = arg('port', '5311');

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
await mkdir(out, { recursive: true });

for (const id of maps) {
  // Render at twice the size and let the browser scale down, for cleaner edges.
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const pose = arg(`pose-${id}`, '');
  const query = `autostart&ui=off&map=${id}&bots=0&q=high${pose ? `&pose=${pose}` : ''}`;
  try {
    await page.goto(`http://127.0.0.1:${port}/?${query}`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 120000 });
    const failure = await page.evaluate(() => window.__ironvale?.error ?? null);
    if (failure) throw new Error(failure);
    await page.waitForTimeout(wait);
    const file = join(out, `${id}.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 82, scale: 'css', clip: { x: 0, y: 0, width: 1280, height: 720 } });
    process.stdout.write(`${file}\n`);
  } catch (error) {
    process.stdout.write(`skipped ${id}: ${error.message.split('\n')[0]}\n`);
  }
  for (const line of [...new Set(errors)].slice(0, 5)) process.stdout.write(`  [pageerror] ${line.slice(0, 300)}\n`);
  await page.close();
}
await browser.close();
