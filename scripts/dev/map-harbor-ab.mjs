// Cost of named Harbor meshes: hides each in turn and compares uncapped frame time, interleaved so GPU contention cancels.
// Usage: node scripts/dev/map-harbor-ab.mjs [--port 5311] [--pose x,y,z,yaw,pitch] [--names harbor-sea,harbor-haze]
import { chromium } from 'playwright';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const port = arg('port', '5311');
const [x, y, z, yaw, pitch] = arg('pose', '-12,0.05,18.5,138,-2').split(',').map(Number);
const names = arg('names', 'harbor-sea,harbor-haze,harbor-glow,harbor-boat').split(',');

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync'],
});
const page = await browser.newPage({ viewport: { width: 1728, height: 1117 }, deviceScaleFactor: 1 });
await page.goto(`http://127.0.0.1:${port}/?autostart&map=harbor&bots=0&ui=off&q=high`, { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
await page.waitForTimeout(2500);
const rows = await page.evaluate(async ({ pose, names }) => {
  const game = window.__ironvale.game;
  game.debugPose(pose.x, pose.y, pose.z, (pose.yaw * Math.PI) / 180, (pose.pitch * Math.PI) / 180);
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const time = async (ms) => {
    for (let i = 0; i < 10; i++) await frame();
    const start = performance.now();
    let frames = 0;
    while (performance.now() - start < ms) {
      await frame();
      frames++;
    }
    return (performance.now() - start) / frames;
  };
  const root = game.engine.scene.getObjectByName('harbor');
  const out = [];
  for (const name of names) {
    const meshes = [];
    root.traverse((child) => child.name === name && meshes.push(child));
    let on = 0;
    let off = 0;
    for (let round = 0; round < 5; round++) {
      for (const mesh of meshes) mesh.visible = true;
      on += await time(700);
      for (const mesh of meshes) mesh.visible = false;
      off += await time(700);
    }
    for (const mesh of meshes) mesh.visible = true;
    out.push({ name, count: meshes.length, on: on / 5, off: off / 5 });
  }
  return out;
}, { pose: { x, y, z, yaw, pitch }, names });
await browser.close();
for (const row of rows) process.stdout.write(`${row.name.padEnd(14)} x${row.count}  shown ${row.on.toFixed(2)} ms  hidden ${row.off.toFixed(2)} ms  cost ${(row.on - row.off).toFixed(2)} ms\n`);
