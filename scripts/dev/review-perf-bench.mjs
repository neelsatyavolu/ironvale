// Measures real render cost per quality tier and per effect.
// Headless Chrome is vsync-capped, so its frame rate says little. Here the engine's loop is
// stopped and frames are driven by hand, each one waiting for the GPU queue to drain, so the
// interval is the serial cost of one frame (CPU + GPU) whatever the display rate.
//
// Usage: node scripts/dev/review-perf-bench.mjs [--maps harbor,pinewood,railyard] [--sizes 1728x1117,2560x1440]
//          [--dpr 1] [--tiers low,medium,high,ultra] [--toggles 1|0] [--webgl] [--json file]
//          [--extra "no=bloom"] [--quantiles] [--sample ms] [--settle ms] [--quiet seconds]
// Each map is loaded with 8 bots; the player is made immortal, holds the trigger, and is put at
// the busiest of a set of probed views (most triangles).
import { execSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const maps = arg('maps', 'harbor,pinewood,railyard').split(',');
const sizes = arg('sizes', '1728x1117,2560x1440').split(',');
const tiers = arg('tiers', 'low,medium,high,ultra').split(',').filter(Boolean);
const dpr = Number(arg('dpr', '1'));
const withToggles = arg('toggles', '1') !== '0';
const webgl = process.argv.includes('--webgl');
const jsonOut = arg('json', '');
/** Extra query appended to every page, e.g. --extra "no=bloom". */
const extra = arg('extra', '');
const SETTLE_MS = Number(arg('settle', '1500'));
const SAMPLE_MS = Number(arg('sample', '3000'));
const QUIET_WAIT_S = Number(arg('quiet', '15'));

/** Live changes applied on top of the high tier, one at a time. */
const TOGGLES = [
  ['high: ssr off', { reflections: false }],
  ['high: ao off', { ambientOcclusion: false }],
  ['high: godrays off', { volumetricLight: false }],
  ['high: bloom off', { bloom: false }],
  ['high: traa off (none)', { antiAliasing: 'none' }],
  ['high: traa -> fxaa', { antiAliasing: 'fxaa' }],
  ['high: shadows off', { shadowMapSize: 0 }],
  ['high: shadows 1024', { shadowMapSize: 1024 }],
  ['high: shadows 2048', { shadowMapSize: 2048 }],
  ['high: shadows 4096 (base again)', {}],
];

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--enable-gpu',
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--hide-scrollbars',
    '--disable-frame-rate-limit',
    '--disable-gpu-vsync',
    '--enable-webgpu-developer-features',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
});

const rows = [];
const problems = new Set();
// The busiest views found by findBusiestPose on the first review run, fixed so runs compare.
// Pass --probe to search again (the result depends on where the bots happen to stand).
const poses = new Map(
  process.argv.includes('--probe')
    ? []
    : [
        ['harbor', { x: -48.5, y: 0.02, z: 33.1, yaw: 5.4978 }],
        ['pinewood', { x: -27.3, y: -1.79, z: -45.3, yaw: 3.927 }],
        ['railyard', { x: -3, y: 0.05, z: 45.5, yaw: 0 }],
      ],
);

async function open(size, map, tier) {
  const [width, height] = size.split('x').map(Number);
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
  // Other reviewers save files while this runs; keep hot reload from restarting the page mid-measurement.
  await page.routeWebSocket(/.*/, () => undefined);
  page.on('console', (message) => {
    if (message.type() === 'error') problems.add(`[${map} ${tier}] ${message.text().replace(/\s+/g, ' ').slice(0, 200)}`);
  });
  page.on('pageerror', (error) => problems.add(`[${map} ${tier}] pageerror ${error.message.slice(0, 200)}`));
  const url = `http://127.0.0.1:5311/?autostart&map=${map}&bots=8&q=${tier}${extra ? `&${extra}` : ''}${webgl ? '&webgl' : ''}`;
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
  const error = await page.evaluate(() => window.__ironvale.error);
  if (error) throw new Error(error);
  return page;
}

/** Probe eight headings from the spawn and from two bot positions; return the view with most triangles. */
async function findBusiestPose(page) {
  return page.evaluate(async () => {
    const game = window.__ironvale.game;
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const spots = [game.player.position.clone()];
    const others = [...game.combat.all()].filter((c) => c.id !== game.player.id).map((c) => c.position.clone());
    if (others.length) spots.push(others[0], others[others.length - 1]);
    let best = null;
    for (const spot of spots) {
      for (let i = 0; i < 8; i++) {
        const yaw = (i * Math.PI) / 4;
        game.debugPose(spot.x, spot.y, spot.z, yaw, 0);
        await frame();
        await frame();
        const info = game.engine.renderer.info.render;
        if (!best || info.triangles > best.triangles) {
          best = { x: spot.x, y: spot.y, z: spot.z, yaw, triangles: info.triangles };
        }
      }
    }
    return best;
  });
}

async function arm(page, pose) {
  await page.evaluate((p) => {
    const game = window.__ironvale.game;
    game.debugPose(p.x, p.y, p.z, p.yaw, 0);
    game.weapons.debugInput = { fire: true };
    if (window.__benchKeep) clearInterval(window.__benchKeep);
    window.__benchKeep = setInterval(() => {
      game.player.health = 100;
      game.weapons.resupply();
      const at = game.player.position;
      if (Math.hypot(at.x - p.x, at.z - p.z) > 0.5 || !game.player.alive) game.debugPose(p.x, p.y, p.z, p.yaw, 0);
    }, 100);
  }, pose);
}

/** Other scripted (Playwright) browsers' GPU processes running right now; ours is one of the count. */
function otherGpuProcesses() {
  try {
    return Math.max(0, execSync('pgrep -f "type=gpu-process.*playwright" | wc -l').toString().trim() - 1);
  } catch {
    return 0;
  }
}

/** Wait (up to a minute) until no other browser is using the GPU, so the sample is clean. */
async function waitForQuiet(page) {
  for (let i = 0; i < QUIET_WAIT_S && otherGpuProcesses() > 0; i++) await page.waitForTimeout(1000);
}

async function measure(page) {
  await waitForQuiet(page);
  await page.waitForTimeout(SETTLE_MS);
  const before = otherGpuProcesses();
  const result = await sample(page);
  return { ...result, contended: before + otherGpuProcesses() > 0 };
}

function sample(page) {
  return page.evaluate(async (sampleMs) => {
    const game = window.__ironvale.game;
    const renderer = game.engine.renderer;
    // Time the two CPU halves of a frame: game systems (frame callbacks) and render submission.
    const cpu = { game: 0, render: 0, frames: 0 };
    const engine = game.engine;
    const callbacks = engine.callbacks;
    const originals = callbacks.slice();
    originals.forEach((callback, index) => {
      callbacks[index] = (dt, elapsed) => {
        const t = performance.now();
        callback(dt, elapsed);
        cpu.game += performance.now() - t;
      };
    });
    const pipeline = engine.pipeline;
    const render = pipeline.render;
    pipeline.render = () => {
      const t = performance.now();
      render();
      cpu.render += performance.now() - t;
      cpu.frames++;
    };
    const dts = [];
    let calls = 0;
    let triangles = 0;
    let triangleSum = 0;
    let last = performance.now();
    // Drive frames by hand, one at a time, and wait for the GPU to finish each before starting
    // the next. The interval is then the serial cost of a frame (CPU work + GPU work). Leaving
    // the engine's own loop running with the frame-rate cap off queues frames faster than the
    // GPU drains them, and the wait then measures the queue, not the frame.
    const device = renderer.backend.device;
    const gl = renderer.backend.gl;
    engine.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (device) await device.queue.onSubmittedWorkDone();
    const begun = performance.now();
    while (performance.now() - begun < sampleMs || dts.length < 10) {
      last = performance.now();
      engine.frame();
      calls = Math.max(calls, renderer.info.render.drawCalls);
      triangles = Math.max(triangles, renderer.info.render.triangles);
      triangleSum += renderer.info.render.triangles;
      if (device) await device.queue.onSubmittedWorkDone();
      else if (gl) gl.finish();
      dts.push(performance.now() - last);
      // Present and let timers run between frames; this wait is not part of the timed interval.
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    engine.start();
    originals.forEach((callback, index) => (callbacks[index] = callback));
    pipeline.render = render;
    dts.sort((a, b) => a - b);
    const mean = dts.reduce((a, b) => a + b, 0) / dts.length;
    const size = renderer.getDrawingBufferSize(new (Object.getPrototypeOf(game.engine.camera.position).constructor)()).toArray();
    return {
      ms: mean,
      cpuGame: cpu.game / Math.max(1, cpu.frames),
      cpuRender: cpu.render / Math.max(1, cpu.frames),
      p10: dts[Math.floor(dts.length * 0.1)],
      quantiles: [0.1, 0.25, 0.4, 0.6, 0.75, 0.9].map((q) => +dts[Math.floor(dts.length * q)].toFixed(1)),
      frames: dts.length,
      p50: dts[Math.floor(dts.length * 0.5)],
      p95: dts[Math.floor(dts.length * 0.95)],
      calls,
      triangles: Math.round(triangles),
      trianglesMean: Math.round(triangleSum / dts.length),
      memMB: Math.round((renderer.info.memory.total ?? 0) / 1048576),
      texMB: Math.round((renderer.info.memory.texturesSize ?? 0) / 1048576),
      textures: renderer.info.memory.textures,
      buffer: `${size[0]}x${size[1]}`,
      scale: game.engine.renderScale,
      webgpu: game.engine.isWebGPU,
    };
  }, SAMPLE_MS);
}

function record(size, map, label, result) {
  rows.push({ size, map, label, ...result });
  if (process.argv.includes('--quantiles')) process.stdout.write(`    ${result.frames} frames, quantiles 10/25/40/60/75/90: ${result.quantiles.join(' ')}\n`);
  // Other headless browsers share this GPU while reviews run, so the mean is noisy. The best
  // decile is the closest thing to an uncontended frame; the median shows how it actually ran.
  process.stdout.write(
    `${result.contended ? '*' : ' '}${size} dpr${dpr} ${map.padEnd(9)} ${label.padEnd(32)} best10% ${result.p10.toFixed(2).padStart(6)} ms  median ${result.p50.toFixed(2).padStart(7)}  mean ${result.ms.toFixed(1).padStart(6)}  cpu game ${result.cpuGame.toFixed(2)} + submit ${result.cpuRender.toFixed(2)}  calls ${String(result.calls).padStart(4)}  tris ${String(result.triangles).padStart(8)} (mean ${String(result.trianglesMean).padStart(8)})  mem ${String(result.memMB).padStart(5)} MB (tex ${result.texMB})  ${result.buffer}\n`,
  );
}

for (const size of sizes) {
  for (const map of maps) {
    for (const tier of tiers) {
      let page;
      try {
        page = await open(size, map, tier);
        if (!poses.has(map)) poses.set(map, await findBusiestPose(page));
        await arm(page, poses.get(map));
        record(size, map, tier, await measure(page));
        if (tier === 'high' && withToggles) {
          const base = await page.evaluate(() => window.__ironvale.game.settings.value.graphics);
          for (const [label, patch] of TOGGLES) {
            await page.evaluate((next) => window.__ironvale.game.settings.update('graphics', next), { ...base, ...patch });
            record(size, map, label, await measure(page));
          }
        }
      } catch (error) {
        process.stdout.write(`${size} ${map} ${tier}: FAILED (${String(error.message).split('\n')[0]})\n`);
      } finally {
        await page?.close();
      }
    }
  }
}
await browser.close();

process.stdout.write('rows marked * were sampled while another browser was using the GPU\n');
process.stdout.write(`poses: ${JSON.stringify(Object.fromEntries(poses))}\n`);
for (const line of [...problems].slice(0, 20)) process.stdout.write(`${line}\n`);
if (jsonOut) await writeFile(jsonOut, JSON.stringify({ dpr, webgl, rows, poses: Object.fromEntries(poses), problems: [...problems] }, null, 1));
