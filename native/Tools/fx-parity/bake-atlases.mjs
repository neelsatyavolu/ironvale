#!/usr/bin/env node
// Bakes the effects' Canvas2D sheets (src/fx/textures.ts createSpriteSheet, decal-sheet.ts,
// flash-sheet.ts) to PNG in Chrome, as PLAN.md 3.4 says: they are seeded, so the PNGs are the web's
// pixels. Writes native/BakedAssets/fx/{sprites,decals,flash}.png (generated, not committed).
// Usage: node native/Tools/fx-parity/bake-atlases.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const out = join(repo, 'native/BakedAssets/fx');
const server = await createServer({
  configFile: join(repo, 'vite.config.ts'),
  root: repo,
  logLevel: 'warn',
  server: { host: '127.0.0.1', port: 5393, strictPort: false, hmr: false, watch: null },
});
await server.listen();
const base = server.resolvedUrls.local[0];
let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ headless: true }));
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
  await page.goto(`${base}native/Tools/fx-parity/atlas.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__atlases, null, { timeout: 120000 });
  const atlases = await page.evaluate(() => window.__atlases);
  mkdirSync(out, { recursive: true });
  for (const [name, url] of Object.entries(atlases)) {
    const file = join(out, `${name}.png`);
    writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
    console.log(file);
  }
} finally {
  await browser?.close();
  await server.close();
}
