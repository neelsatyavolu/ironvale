// Draw calls, triangles and uncapped frame time at each review pose of the Harbor map.
// Usage: node scripts/dev/map-harbor-perf.mjs [--port 5311] [--q high] [--bots 0]
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const port = arg('port', '5311');
const tier = arg('q', 'high');
const bots = arg('bots', '0');
const { poses } = JSON.parse(await readFile(new URL('./map-harbor-poses.json', import.meta.url), 'utf8'));
const all = [...poses, { name: 'bench', pose: '-48.5,0.02,33.1,-45,0' }];

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: 1728, height: 1117 }, deviceScaleFactor: 1 });
const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
await page.goto(`http://127.0.0.1:${port}/?autostart&map=harbor&bots=${bots}&ui=off&q=${tier}`, { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
await page.waitForTimeout(2500);
let worst = { calls: 0, triangles: 0, ms: 0 };
for (const { name, pose } of all) {
  const [x, y, z, yaw, pitch] = pose.split(',').map(Number);
  const row = await page.evaluate(async (p) => {
    const game = window.__ironvale.game;
    game.debugPose(p.x, p.y, p.z, (p.yaw * Math.PI) / 180, (p.pitch * Math.PI) / 180);
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    for (let i = 0; i < 30; i++) await frame();
    const start = performance.now();
    let frames = 0;
    while (performance.now() - start < 2500) {
      await frame();
      frames++;
    }
    const info = game.engine.renderer.info.render;
    return { calls: info.drawCalls ?? info.calls, triangles: info.triangles, ms: (performance.now() - start) / frames, scale: game.engine.renderScale };
  }, { x, y, z, yaw, pitch });
  worst = { calls: Math.max(worst.calls, row.calls), triangles: Math.max(worst.triangles, row.triangles), ms: Math.max(worst.ms, row.ms) };
  process.stdout.write(`${name.padEnd(10)} calls ${String(row.calls).padStart(4)}  tris ${String(row.triangles).padStart(8)}  ${row.ms.toFixed(2)} ms  scale ${row.scale}\n`);
}
await browser.close();
process.stdout.write(`worst      calls ${worst.calls}  tris ${worst.triangles}  ${worst.ms.toFixed(2)} ms\n`);
for (const line of [...new Set(problems)].slice(0, 6)) process.stdout.write(`[pageerror] ${line.slice(0, 200)}\n`);
