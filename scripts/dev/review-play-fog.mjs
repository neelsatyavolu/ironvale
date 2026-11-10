// Stands five soldiers 25, 35, 45, 55 and 65 m away on a clear sight line and photographs them, to judge how far
// the player can really see on a map. Compare with the bots' sight range in src/ai/perception.ts (VISION.fogVisibility).
// Usage: node scripts/dev/review-play-fog.mjs pinewood   ->  shots/review-play-fog-<map>.png and -crop.png
import { chromium } from 'playwright';
const map = process.argv[2] ?? 'pinewood';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.routeWebSocket(/.*/, () => undefined);
await page.goto('http://127.0.0.1:5311/?q=high');
await page.waitForFunction(() => window.__ironvale?.ready);
await page.evaluate((mapId) => window.__ironvale.game.startMatch({ mapId, mode: 'skirmish', difficulty: 'recruit', botCount: 5 }), map);
const info = await page.evaluate(() => {
  const g = window.__ironvale.game; const grid = g.bots.grid; const V = g.player.position.constructor;
  const dists = [25, 35, 45, 55, 65];
  // find a walkable origin and heading with clear sight to all four distances
  let best = null;
  for (let n = 0; n < grid.nodeCount && !best; n += 37) {
    if (!grid.edges[n]) continue;
    const ox = grid.nodeX(n), oy = grid.nodeY[n], oz = grid.nodeZ(n);
    for (let a = 0; a < 360 && !best; a += 5) {
      const yaw = a * Math.PI / 180; const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
      const pts = [];
      for (const d of dists) {
        const side = (dists.indexOf(d) - 2) * 2.5; const node = grid.nearestNode(ox + dx * d + dz * side, oy, oz + dz * d - dx * side, 1);
        if (node < 0) break;
        const p = new V(grid.nodeX(node), grid.nodeY[node], grid.nodeZ(node));
        if (!g.world.lineOfSight(new V(ox, oy + 1.64, oz), p.clone().setY(p.y + 1.2))) break;
        if (!g.world.lineOfSight(new V(ox, oy + 1.64, oz), p.clone().setY(p.y + 0.3))) break;
        pts.push(p);
      }
      if (pts.length === dists.length) best = { ox, oy, oz, yaw, pts };
    }
  }
  if (!best) return 'no line';
  g.bots.update = () => {};
  const bots = g.bots.bots;
  best.pts.forEach((p, i) => { const b = bots[i]; b.position.copy(p); b.visual.root.position.copy(p); b.visual.root.rotation.y = best.yaw + Math.PI; b.visual.update(0.016); });
  g.debugPose(best.ox, best.oy, best.oz, best.yaw, 0);
  g.weapons.debugInput = {};
  window.__pts = best.pts; return { at: [best.ox, best.oy, best.oz], yaw: best.yaw };
});
console.log(JSON.stringify(info));
await page.waitForTimeout(3000);
await page.screenshot({ path: `shots/review-play-fog-${map}.png` });
const px = await page.evaluate(() => { const g = window.__ironvale.game; const cam = g.engine.camera; cam.updateMatrixWorld(true); return window.__pts.map((p) => { const v = p.clone(); v.y += 0.9; v.project(cam); return [Math.round((v.x * 0.5 + 0.5) * innerWidth), Math.round((1 - (v.y * 0.5 + 0.5)) * innerHeight)]; }); });
console.log(JSON.stringify(px));
const lo = Math.max(0, Math.min(...px.map((p) => p[0])) - 60), hi = Math.min(1600, Math.max(...px.map((p) => p[0])) + 60);
await page.screenshot({ path: `shots/review-play-fog-${map}-crop.png`, clip: { x: lo, y: 380, width: hi - lo, height: 140 } });
await browser.close();
