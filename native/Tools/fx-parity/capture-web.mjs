#!/usr/bin/env node
// Web reference captures for the M9 FX check (check-m9fx.sh), with the effects on.
//
// Loads ?autostart&map=ID&bots=0&pose=...&q=high&no=grain&freeze once per map (Chrome, WebGPU), as
// native/Tools/m3-parity/capture-web.mjs does, but keeps the effects root ('fx') in the scene: the
// map's weather (rain, mist, motes) and, with --scene, a scripted burst of combat events.
//
// --scene: for each pose the effects are reset (effects.leaveMap/enterMap), the scene's shots are
// resolved against the web's own collision world (game.world.raycast), and the resulting GameEvents
// are emitted on game.events. While they are handled, Math.random calls made from src/fx/ draw from
// mulberry32(seed) (src/core/random.ts), so the native port, drawing from the same stream in the same
// order, places every effect where the web does. Under ?freeze the effect clock stays at 0: what
// shows is each effect's first frame (flashes, flash light, decals, rings, casings; particles fade in
// over 35 ms and tracers start at zero length, so neither shows on either side). The resolved events
// are written next to each capture (<map>-<pose>.events.json) for the native side to replay.
//
// Usage: node native/Tools/fx-parity/capture-web.mjs --map ID --out DIR [--scene] [--seed N] [--settle MS]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const out = resolve(option('out', join(repo, 'native/Parity/m9fx/web')));
const mapId = option('map', 'railyard');
const scene = args.includes('--scene');
const seed = Number(option('seed', '24301'));
const settle = Number(option('settle', '2500'));
const { poses } = JSON.parse(readFileSync(join(repo, `native/Parity/${mapId}-poses.json`), 'utf8'));
const { shots, impacts, grenades } = JSON.parse(readFileSync(join(here, 'scene.json'), 'utf8'));
const names = Object.keys(poses);

const server = await createServer({
  configFile: join(repo, 'vite.config.ts'),
  root: repo,
  logLevel: 'warn',
  server: { host: '127.0.0.1', port: 5395, strictPort: false, hmr: false, watch: null },
});
await server.listen();
const base = server.resolvedUrls.local[0];
const flags = ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: flags }).catch(() => chromium.launch({ headless: true, args: flags }));
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
  // The effects' cosmetic randomness, from a seeded stream while __fxSeed is armed; everything else
  // (audio variation, three's uuids) keeps the browser's Math.random.
  await page.addInitScript(() => {
    const native = Math.random.bind(Math);
    let state = null;
    window.__fxDraws = 0;
    window.__armFx = (seed) => {
      state = seed >>> 0;
      window.__fxDraws = 0;
    };
    Math.random = () => {
      if (state === null || !/\/src\/fx\//.test(new Error().stack ?? '')) return native();
      window.__fxDraws++;
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  });
  const first = poses[names[0]].join(',');
  await page.goto(`${base}?autostart&map=${mapId}&bots=0&pose=${first}&q=high&no=grain&freeze`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 300000 });
  const error = await page.evaluate(() => window.__ironvale?.error ?? null);
  if (error) throw new Error(`web build failed to start: ${error}`);
  await page.addStyleTag({ content: 'body * { visibility: hidden !important; } canvas#view { visibility: visible !important; }' });
  mkdirSync(out, { recursive: true });
  for (const name of names) {
    const [x, y, z, yaw, pitch] = poses[name];
    const result = await page.evaluate(
      async ({ pose: [px, py, pz, pyaw, ppitch], scene, shots, impacts, grenades, seed }) => {
        const { game } = window.__ironvale;
        const { WEAPON_DEFS } = await import('/src/weapons/defs.ts');
        const camera = game.engine.camera;
        for (const child of [...camera.children]) camera.remove(child);
        game.debugPose(px, py, pz, (pyaw * Math.PI) / 180, (ppitch * Math.PI) / 180);
        if (!scene) return { events: [], draws: 0 };
        game.effects.leaveMap();
        game.effects.enterMap(game.map);
        camera.updateMatrixWorld(true);
        const V = camera.position.constructor;
        const eye = camera.position.clone();
        const right = new V(1, 0, 0).applyQuaternion(camera.quaternion);
        const up = new V(0, 1, 0).applyQuaternion(camera.quaternion);
        const forward = new V(0, 0, -1).applyQuaternion(camera.quaternion);
        const at = ([r, u, f]) => eye.clone().addScaledVector(right, r).addScaledVector(up, u).addScaledVector(forward, f);
        const arr = (v) => [v.x, v.y, v.z];
        const events = [];
        const cast = (from, toward) => {
          const dir = toward.clone().sub(from).normalize();
          return { dir, hit: game.world.raycast(from, dir, 150) };
        };
        for (const shot of shots) {
          const from = at(shot.from);
          const { dir, hit } = cast(from, at(shot.toward));
          const to = hit ? hit.point : from.clone().addScaledVector(dir, 150);
          events.push({ type: 'shotFired', weapon: { id: shot.weapon }, a: arr(from), b: arr(dir) });
          events.push({ type: 'bulletTrace', weapon: { id: shot.weapon }, a: arr(from), b: arr(to) });
          if (hit) events.push({ type: 'bulletImpact', weapon: { id: shot.weapon }, a: arr(hit.point), normal: arr(hit.normal), surface: hit.surface });
          const side = new V(-dir.z, 0, dir.x).normalize();
          events.push({ type: 'casingEjected', kind: 'rifle', a: arr(from.clone().addScaledVector(side, 0.08)), b: [side.x * 2, 1.4, side.z * 2] });
        }
        for (const impact of impacts) {
          const { hit } = cast(eye, at(impact));
          if (hit) events.push({ type: 'bulletImpact', weapon: { id: 'm4a1' }, a: arr(hit.point), normal: arr(hit.normal), surface: hit.surface });
        }
        for (const g of grenades) {
          const { hit } = cast(eye, at(g));
          if (hit && hit.normal.y > 0.5) events.push({ type: 'grenadeExploded', a: [hit.point.x, hit.point.y + 0.1, hit.point.z] });
        }
        window.__armFx(seed);
        for (const e of events) {
          const vec = (a) => new V(a[0], a[1], a[2]);
          const weapon = e.weapon ? WEAPON_DEFS[e.weapon.id] : undefined;
          if (e.type === 'shotFired') game.events.emit('shotFired', { shooterId: 7, weapon, muzzle: vec(e.a), direction: vec(e.b), local: false });
          else if (e.type === 'bulletTrace') game.events.emit('bulletTrace', { shooterId: 7, weapon, from: vec(e.a), to: vec(e.b), local: false });
          else if (e.type === 'bulletImpact')
            game.events.emit('bulletImpact', { shooterId: 7, weapon, hit: { point: vec(e.a), normal: vec(e.normal), distance: 10, surface: e.surface } });
          else if (e.type === 'casingEjected') game.events.emit('casingEjected', { kind: e.kind, position: vec(e.a), velocity: vec(e.b) });
          else if (e.type === 'grenadeExploded') game.events.emit('grenadeExploded', { ownerId: 7, position: vec(e.a), local: false });
        }
        return { events, draws: window.__fxDraws };
      },
      { pose: [x, y, z, yaw, pitch], scene, shots, impacts, grenades, seed },
    );
    await page.waitForTimeout(settle);
    // Draws made after the events (a later frame) would mean the native side cannot match.
    const draws = await page.evaluate(() => window.__fxDraws);
    if (scene && draws !== result.draws) throw new Error(`${name}: ${draws - result.draws} effect random draws after the events`);
    const file = join(out, `${mapId}-${name}.png`);
    await page.locator('canvas#view').screenshot({ path: file, timeout: 120000 });
    if (scene) writeFileSync(join(out, `${mapId}-${name}.events.json`), JSON.stringify({ seed, draws, events: result.events }, null, 1));
    console.log(`${file}${scene ? ` (${result.events.length} events, ${draws} draws)` : ''}`);
  }
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
