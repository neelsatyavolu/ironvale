// Prints GPU time per render pass (WebGPU timestamp queries) for one view, plus adapter info.
// Usage: node scripts/dev/review-perf-passes.mjs "<query, e.g. map=harbor&bots=8&q=high&pose=...>" [WxH] [dpr]
import { chromium } from 'playwright';

const query = process.argv[2] ?? 'map=harbor&bots=8&q=high';
const [width, height] = (process.argv[3] ?? '1728x1117').split('x').map(Number);
const dpr = Number(process.argv[4] ?? 1);
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync', '--enable-webgpu-developer-features'],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
await page.routeWebSocket(/.*/, () => undefined);
page.on('pageerror', (error) => process.stdout.write(`pageerror ${error.message}\n`));
await page.goto(`http://127.0.0.1:5311/?autostart&${query}&gputime`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
await page.waitForTimeout(3000);
const result = await page.evaluate(async () => {
  const game = window.__ironvale.game;
  const renderer = game.engine.renderer;
  const backend = renderer.backend;
  const sums = new Map();
  let frames = 0;
  const dts = [];
  for (let i = 0; i < 60; i++) {
    const t0 = performance.now();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await backend.device.queue.onSubmittedWorkDone();
    dts.push(performance.now() - t0);
    await renderer.resolveTimestampsAsync('render');
    const pool = backend.timestampQueryPool.render;
    const last = pool.frames[pool.frames.length - 1];
    let order = 0;
    for (const [uid, ms] of pool.timestamps) {
      if (!uid.endsWith(`:f${last}`)) continue;
      const key = `${String(order++).padStart(2, '0')} ${uid.replace(/:f\d+$/, '')}`;
      sums.set(key, (sums.get(key) ?? 0) + ms);
    }
    frames++;
  }
  const info = backend.device.adapterInfo ?? {};
  return {
    adapter: { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description },
    passes: [...sums].map(([key, ms]) => [key, +(ms / frames).toFixed(3)]),
    total: +([...sums.values()].reduce((a, b) => a + b, 0) / frames).toFixed(2),
    frameMs: dts.sort((a, b) => a - b)[30],
    calls: renderer.info.render.drawCalls,
    triangles: renderer.info.render.triangles,
  };
});
await browser.close();
process.stdout.write(`${JSON.stringify(result.adapter)}\ncalls ${result.calls} triangles ${result.triangles} pass spans sum ${result.total} ms, median frame ${result.frameMs.toFixed(1)} ms\n`);
for (const [key, ms] of result.passes) process.stdout.write(`${String(ms).padStart(8)} ms  ${key}\n`);
