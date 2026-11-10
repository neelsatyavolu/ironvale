// In-game check of the soldiers: starts a match with bots, puts the camera a few metres from the
// nearest one, screenshots, and reports pose-skipping, draw calls and frame time.
// Usage: node scripts/dev/characters-game.mjs <out-name> [map] [bots] [distance] [settle-ms]
// A short settle (200) catches the soldier before it has moved off; the default lets the frame time settle.
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [out = 'game', map = 'range', bots = '8', distance = '6', settle = '1500'] = process.argv.slice(2);
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const problems = new Set();
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.add(`[${message.type()}] ${message.text()}`);
});
page.on('pageerror', (error) => problems.add(`[pageerror] ${error.message}`));
await page.goto(`http://127.0.0.1:5311/?autostart&map=${map}&bots=${bots}`, { waitUntil: 'load', timeout: 30000 });
await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 90000 });
await page.waitForTimeout(2500);

const report = await page.evaluate(async ({ distance, settle }) => {
  const game = window.__ironvale.game;
  const scene = game.engine.scene;
  const soldiers = scene.children.filter((child) => child.name.startsWith('soldier-'));
  if (soldiers.length === 0) return { soldiers: 0 };
  const camera = game.engine.camera;
  let nearest = soldiers[0];
  for (const soldier of soldiers) if (soldier.position.distanceTo(camera.position) < nearest.position.distanceTo(camera.position)) nearest = soldier;
  // Stand in front of the nearest soldier, looking back at it.
  const yaw = nearest.rotation.y;
  const x = nearest.position.x - Math.sin(yaw) * distance + Math.cos(yaw) * 1.5;
  const z = nearest.position.z - Math.cos(yaw) * distance - Math.sin(yaw) * 1.5;
  const look = Math.atan2(-(nearest.position.x - x), -(nearest.position.z - z));
  game.debugPose(x, nearest.position.y, z, look, 0);
  await new Promise((resolve) => setTimeout(resolve, settle));
  const info = game.engine.renderer?.info;
  const meshes = [];
  scene.traverse((child) => { if (child.isSkinnedMesh) meshes.push(child); });
  return {
    soldiers: soldiers.length,
    nearest: nearest.position.toArray().map((v) => +v.toFixed(2)),
    frameMs: game.engine.frameTimeMs,
    drawCalls: info?.render?.drawCalls ?? null,
    triangles: info?.render?.triangles ?? null,
    skinned: meshes.length,
    trianglesPerSoldier: meshes[0] ? meshes[0].geometry.index.count / 3 : null,
  };
}, { distance: Number(distance), settle: Number(settle) });
await mkdir(join(root, 'shots'), { recursive: true });
const file = join(root, 'shots', `characters-${out}.png`);
await page.screenshot({ path: file });
await browser.close();
process.stdout.write(`${file}\n${JSON.stringify(report)}\n`);
for (const line of [...problems].slice(0, 15)) process.stdout.write(`${line.slice(0, 300)}\n`);
