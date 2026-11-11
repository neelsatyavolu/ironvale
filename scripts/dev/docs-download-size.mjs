// Measures what a player downloads to start each map: every asset and font request the page makes
// up to the first playable frame, at the 1k (medium) and 2k (high) texture tiers, sized from the
// files on disk. Needs the dev server (npm run dev).
//   node scripts/dev/docs-download-size.mjs
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAPS = ['harbor', 'headworks', 'railyard'];
const TIERS = [
  ['1k', 'medium'],
  ['2k', 'high'],
];
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
});

async function measure(map, quality) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const files = new Map();
  const failed = [];
  page.on('response', (response) => {
    const path = decodeURIComponent(new URL(response.url()).pathname);
    if (response.status() >= 400) failed.push(`${response.status()} ${path}`);
    if (!path.startsWith('/assets/dl/') && !path.startsWith('/assets/local/') && !path.startsWith('/assets/thumbs/') && !path.startsWith('/fonts/')) return;
    try {
      files.set(path, statSync(join(root, 'public', path)).size);
    } catch {
      failed.push(`not on disk ${path}`);
    }
  });
  await page.goto(`http://127.0.0.1:5311/?autostart&map=${map}&bots=8&q=${quality}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 180000 });
  await page.waitForTimeout(4000);
  const error = await page.evaluate(() => window.__ironvale.error);
  await context.close();
  if (error) throw new Error(`${map} ${quality}: ${error}`);
  return { files, failed };
}

const total = (files) => [...files.values()].reduce((sum, size) => sum + size, 0);
const largest = new Map();
for (const [tier, quality] of TIERS) {
  const runs = [];
  for (const map of MAPS) runs.push({ map, ...(await measure(map, quality)) });
  const shared = new Map([...runs[0].files].filter(([path]) => runs.every((run) => run.files.has(path))));
  const kinds = { sounds: 0, models: 0, other: 0 };
  for (const [path, size] of shared) kinds[path.includes('/sounds/') ? 'sounds' : path.endsWith('.glb') ? 'models' : 'other'] += size;
  process.stdout.write(`\n${tier} tier (q=${quality})\n`);
  process.stdout.write(`  shared by all maps: ${mb(total(shared))} in ${shared.size} files (sounds ${mb(kinds.sounds)}, models ${mb(kinds.models)}, other ${mb(kinds.other)})\n`);
  for (const run of runs) {
    const own = new Map([...run.files].filter(([path]) => !shared.has(path)));
    process.stdout.write(`  ${run.map}: ${mb(total(run.files))} in ${run.files.size} files, of which ${mb(total(own))} in ${own.size} files is the map's own\n`);
    for (const line of run.failed) process.stdout.write(`    ! ${line}\n`);
    for (const [path, size] of run.files) largest.set(path, size);
  }
}
process.stdout.write('\nlargest files requested\n');
for (const [path, size] of [...largest].sort((a, b) => b[1] - a[1]).slice(0, 8)) process.stdout.write(`  ${mb(size)}  ${path}\n`);
await browser.close();
