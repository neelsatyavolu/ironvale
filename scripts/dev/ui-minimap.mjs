// Minimap checks in a running match: screenshots, dot positions against bot positions, the setting, and frame cost.
// Usage: node scripts/dev/ui-minimap.mjs [map ...]  ->  shots/ui-minimap-<map>.png and -zoom.png (needs npm run dev)
import { chromium } from 'playwright';

const maps = process.argv.length > 2 ? process.argv.slice(2) : ['railyard', 'harbor', 'headworks'];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'] });

for (const map of maps) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text().slice(0, 200)));
  page.on('pageerror', (e) => problems.push(e.message));
  await page.goto(`http://127.0.0.1:5311/?autostart&map=${map}&bots=8&q=medium`);
  await page.waitForFunction(() => window.__ironvale?.ready, null, { timeout: 120000 });
  await page.waitForTimeout(2500);

  // Stand in the middle of the enemies so most of them are inside the 45 m window.
  await page.evaluate(() => {
    const game = window.__ironvale.game;
    const bots = game.combat.all().filter((c) => c.kind === 'bot' && c.alive);
    const cx = bots.reduce((sum, b) => sum + b.position.x, 0) / bots.length;
    const cz = bots.reduce((sum, b) => sum + b.position.z, 0) / bots.length;
    const node = game.bots.grid.nearestNode(cx, bots[0].position.y, cz, 40);
    const grid = game.bots.grid;
    game.debugPose(grid.nodeX(node), grid.nodeY[node] + 0.05, grid.nodeZ(node), 0.6, 0);
    // One enemy has just fired.
    const shooter = bots[0];
    game.events.emit('shotFired', { shooterId: shooter.id, weapon: game.weapons.current.def, muzzle: shooter.position.clone(), direction: shooter.position.clone(), local: false });
  });
  await page.waitForTimeout(250);

  // Cost inside real frames, before anything reads the canvas back: time the frame callback over 240 frames.
  const live = await page.evaluate(async () => {
    const engine = window.__ironvale.game.engine;
    const draw = engine.callbacks.find((cb) => cb.name === 'drawMinimap');
    if (!draw) return null;
    let total = 0, worst = 0, frames = 0;
    const timed = (dt, elapsed) => { const t = performance.now(); draw(dt, elapsed); const ms = performance.now() - t; total += ms; worst = Math.max(worst, ms); frames++; };
    engine.callbacks = engine.callbacks.map((cb) => (cb === draw ? timed : cb));
    while (frames < 240) await new Promise((resolve) => requestAnimationFrame(resolve));
    engine.callbacks = engine.callbacks.map((cb) => (cb === timed ? draw : cb));
    return { frames, meanMs: +(total / frames).toFixed(4), worstMs: +worst.toFixed(3) };
  });

  // Draw one frame and read the canvas back in the same task, so nothing moves in between.
  const check = await page.evaluate(() => {
    const game = window.__ironvale.game;
    const draw = game.engine.callbacks.find((cb) => cb.name === 'drawMinimap');
    const canvas = document.querySelector('.iv-minimap__canvas');
    if (!draw || !canvas) return { error: 'minimap not found' };
    draw(0, 0);
    const g = canvas.getContext('2d');
    const ratio = canvas.width / canvas.clientWidth;
    const half = canvas.clientWidth / 2;
    const scale = half / 45;
    const limit = half - 3;
    const player = game.player;
    const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
    const rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
    const inkAt = (x, y) => {
      const d = g.getImageData(Math.round((half + x) * ratio) - 1, Math.round((half + y) * ratio) - 1, 3, 3).data;
      let bright = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 225 && d[i + 1] > 222 && d[i + 2] > 215 && d[i + 3] > 240) bright++;
      return bright;
    };
    const bots = game.combat.all().filter((c) => c.kind === 'bot' && c.alive);
    const rows = bots.map((bot) => {
      const dx = bot.position.x - player.position.x, dz = bot.position.z - player.position.z;
      // Independent of the game's own transform: metres to the right and metres ahead.
      let x = (dx * rx + dz * rz) * scale, y = -(dx * fx + dz * fz) * scale;
      const length = Math.hypot(x, y);
      const outside = length > limit;
      if (outside) { x *= (limit - 2) / length; y *= (limit - 2) / length; }
      const otherFloor = Math.abs(bot.position.y - player.position.y) > 2;
      // A hollow dot is dark in the middle: look on its ring instead.
      const ink = otherFloor && !outside ? inkAt(x + 2.5, y) + inkAt(x - 2.5, y) : inkAt(x, y);
      return { id: bot.id, metres: +Math.hypot(dx, dz).toFixed(1), dy: +(bot.position.y - player.position.y).toFixed(1), x: +x.toFixed(1), y: +y.toFixed(1), outside, otherFloor, ink };
    });
    // Cost of a frame: the draw call alone, repeated.
    const runs = 3000;
    for (let i = 0; i < 200; i++) draw(0, 0);
    const started = performance.now();
    for (let i = 0; i < runs; i++) draw(0, 0);
    const ms = (performance.now() - started) / runs;
    // The same with the canvas forced to rasterise and read a pixel back each time: an upper bound.
    const flushed = performance.now();
    for (let i = 0; i < 300; i++) { draw(0, 0); g.getImageData(0, 0, 1, 1); }
    const flushMs = (performance.now() - flushed) / 300;
    const grid = game.bots.grid;
    return { canvas: `${canvas.width}x${canvas.height} for ${canvas.clientWidth} css px`, grid: `${grid.nx}x${grid.nz}`, bots: bots.length, missing: rows.filter((r) => r.ink === 0).length, rows, drawMs: +ms.toFixed(4), drawAndReadbackMs: +flushMs.toFixed(4) };
  });
  await page.waitForTimeout(120);
  await page.screenshot({ path: `shots/ui-minimap-${map}.png` });
  await page.locator('.iv-minimap').screenshot({ path: `shots/ui-minimap-${map}-zoom.png` });

  // The setting hides it and the kill feed goes back to the corner.
  const setting = await page.evaluate(async () => {
    const game = window.__ironvale.game;
    const element = document.querySelector('.iv-minimap');
    const feedTop = () => getComputedStyle(document.querySelector('.iv-feed')).top;
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const on = { hidden: element.hidden, feedTop: feedTop() };
    game.settings.update('gameplay', { minimap: false });
    await frame();
    const off = { hidden: element.hidden, width: element.offsetWidth, feedTop: feedTop() };
    game.settings.update('gameplay', { minimap: true });
    await frame();
    return { on, off, backOn: { hidden: element.hidden, width: element.offsetWidth } };
  });
  await page.close();
  process.stdout.write(`${map}: ${JSON.stringify({ ...check, rows: undefined })}\n`);
  for (const row of check.rows ?? []) process.stdout.write(`  ${JSON.stringify(row)}\n`);
  process.stdout.write(`  live frames ${JSON.stringify(live)}\n`);
  process.stdout.write(`  setting ${JSON.stringify(setting)}\n  problems ${JSON.stringify(problems.slice(0, 5))}\n`);
}
await browser.close();
