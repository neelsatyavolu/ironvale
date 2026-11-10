// Top-down plan of Pinewood with fog off and crowns hidden: spawns, route centre lines and a 10 m grid
// are drawn over the render. Also prints, for every enemy spawn, which player spawns it can see at eye
// height and how far apart they are.
// Usage: node scripts/dev/map-pinewood-plan.mjs [--out name] [--crowns]
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const out = arg('out', 'map-pinewood-plan');
const keepCrowns = process.argv.includes('--crowns');

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1400 }, deviceScaleFactor: 1 });
page.on('pageerror', (error) => process.stdout.write(`[pageerror] ${error.message}\n`));

const setup = async () => {
  await page.waitForFunction(() => window.__ironvale?.error || (window.__ironvale?.ready && window.__ironvale.game.map), null, { timeout: 120000 });
  return page.evaluate((showCrowns) => {
    const game = window.__ironvale.game;
    const { engine, map } = game;
    engine.scene.fog.density = 0;
    map.root.traverse((object) => {
      if (object.isMesh && object.material.alphaTest > 0 && object.isInstancedMesh && !showCrowns) object.material.visible = false;
      if (object.isMesh && object.material.blending === 2) object.visible = false;
    });
    game.debugPose(0, 150, 0, 0, -Math.PI / 2 + 0.0001);
    document.querySelectorAll('body > *:not(canvas)').forEach((node) => (node.style.visibility = 'hidden'));
    return true;
  }, keepCrowns);
};

// Other agents' edits hot-reload the page; retry until one pass completes on a settled page.
let report = null;
for (let attempt = 1; attempt <= 6 && !report; attempt++) {
  try {
    if (attempt === 1) await page.goto('http://127.0.0.1:5311/?autostart&map=pinewood&bots=0&q=high&no=godrays,bloom,grain', { waitUntil: 'load' });
    await setup();
    await page.waitForTimeout(1500);
    report = await page.evaluate(() => {
      const game = window.__ironvale.game;
      const { engine, map, world } = game;
      const Vector3 = engine.camera.position.constructor;
      const layer = document.createElement('div');
      layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;font:11px monospace;z-index:99999';
      document.body.appendChild(layer);
      const project = (x, y, z) => {
        const p = new Vector3(x, y, z).project(engine.camera);
        return [(p.x * 0.5 + 0.5) * innerWidth, (-p.y * 0.5 + 0.5) * innerHeight];
      };
      const dot = (x, z, color, label, size = 9) => {
        const [sx, sy] = project(x, world.groundHeight(x, z, 40, 80) ?? 0, z);
        const node = document.createElement('div');
        node.style.cssText = `position:absolute;left:${sx - size / 2}px;top:${sy - size / 2}px;width:${size}px;height:${size}px;border-radius:50%;background:${color};border:1px solid #000`;
        layer.appendChild(node);
        if (!label) return;
        const text = document.createElement('div');
        text.textContent = label;
        text.style.cssText = `position:absolute;left:${sx + 6}px;top:${sy - 7}px;color:#fff;text-shadow:0 0 3px #000,0 0 3px #000`;
        layer.appendChild(text);
      };
      for (let g = -50; g <= 50; g += 10) {
        dot(g, 58, '#fff', `x${g}`, 3);
        dot(-52, g, '#fff', `z${g}`, 3);
      }
      map.playerSpawns.forEach((spawn, i) => dot(spawn.position.x, spawn.position.z, '#3af', `P${i}`));
      map.enemySpawns.forEach((spawn, i) => dot(spawn.position.x, spawn.position.z, '#f43', `E${i}`));
      const eye = (spawn) => spawn.position.clone().setY(spawn.position.y + 1.64);
      const lines = [];
      map.enemySpawns.forEach((enemy, i) => {
        const seen = map.playerSpawns
          .map((player, k) => ({ k, clear: world.lineOfSight(eye(enemy), eye(player)), distance: enemy.position.distanceTo(player.position) }))
          .filter((entry) => entry.clear);
        const nearest = Math.min(...map.playerSpawns.map((player) => enemy.position.distanceTo(player.position)));
        lines.push(`E${i} (${enemy.position.x.toFixed(0)}, ${enemy.position.z.toFixed(0)}): nearest player spawn ${nearest.toFixed(0)} m, sees ${seen.length ? seen.map((s) => `P${s.k}@${s.distance.toFixed(0)}m`).join(' ') : 'none'}`);
      });
      return lines;
    });
  } catch (error) {
    if (attempt === 6) throw error;
    await page.waitForTimeout(2000);
  }
}
await page.waitForTimeout(800);
await mkdir(join(root, 'shots'), { recursive: true });
const file = join(root, 'shots', `${out}.png`);
await page.screenshot({ path: file });
await browser.close();
process.stdout.write(`${file}\n${report.join('\n')}\n`);
