// Samples the engine's frame time on model-viewer pages, on WebGPU and on the WebGL2 fallback.
// Each page is left to settle (shader compilation, texture upload), then sampled several times.
// Usage: node scripts/dev/guns-c-frametime.mjs "<label>=<viewer query>" ...
import { chromium } from 'playwright';

const SETTLE_MS = 6000;
const SAMPLES = 8;
const GAP_MS = 400;
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
for (const spec of process.argv.slice(2)) {
  const [label, query] = [spec.slice(0, spec.indexOf('=')), spec.slice(spec.indexOf('=') + 1)];
  for (const backend of ['webgpu', 'webgl']) {
    const browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
      // Other agents save files while this runs and the dev server would reload the page mid-measurement.
      // Keep the hot-reload socket open but silent so the page that was loaded stays put.
      await page.routeWebSocket(/.*/, () => undefined);
      const problems = [];
      page.on('pageerror', (error) => problems.push(error.message));
      await page.goto(`http://127.0.0.1:5311/?${query}${backend === 'webgl' ? '&webgl' : ''}`, { waitUntil: 'load', timeout: 30000 });
      await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 60000 });
      await page.waitForTimeout(SETTLE_MS);
      const samples = [];
      for (let i = 0; i < SAMPLES; i++) {
        samples.push(await page.evaluate(() => window.__ironvale.game.engine.frameTimeMs));
        await page.waitForTimeout(GAP_MS);
      }
      const isWebGPU = await page.evaluate(() => window.__ironvale.game.engine.isWebGPU);
      process.stdout.write(
        `${label} ${isWebGPU ? 'WebGPU' : 'WebGL2'}: median ${median(samples).toFixed(1)} ms, min ${Math.min(...samples).toFixed(1)}, max ${Math.max(...samples).toFixed(1)}${problems.length ? ` problems: ${problems.join(' | ')}` : ''}\n`,
      );
    } catch (error) {
      process.stdout.write(`${label} ${backend}: FAILED to measure (${String(error.message).split('\n')[0]})\n`);
    } finally {
      await browser.close();
    }
  }
}
