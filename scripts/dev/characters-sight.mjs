// Where the soldier's right eye sits relative to the rifle, in the rifle's own space, for each state given.
// A good sight picture has the eye a few centimetres behind the rear sight (z 0.02 to 0.12), on the
// centre line (x near 0) and at sight height (y about 0.16).
// Usage: node scripts/dev/characters-sight.mjs "state=aim" "state=aim&aimpitch=30" ...
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 480, height: 360 } });
page.on('pageerror', (error) => process.stdout.write(`[pageerror] ${error.message}\n`));
for (const query of process.argv.slice(2)) {
  await page.goto(`http://127.0.0.1:5311/?view=characters/soldier&floor=0&face=0&t=1.2&${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const result = await page.evaluate(() => {
    const soldier = window.__soldiers[0].visual;
    soldier.root.updateWorldMatrix(true, true);
    const head = soldier.root.getObjectByName('Head');
    const gun = soldier.root.getObjectByName('carbine');
    const eye = head.position.clone().set(0, 0, 0);
    // Right eye in the head joint's frame is found from the rest pose: 8.5 cm up, 8.5 cm forward, 3.2 cm right, in model axes.
    const m = head.matrixWorld.elements;
    const headWorld = { x: m[12], y: m[13], z: m[14] };
    const rest = window.__soldierEyeOffset ?? null;
    const q = head.getWorldQuaternion(head.quaternion.clone());
    const restQ = soldier.rig.restModel[soldier.rig.restModel.length > 5 ? 5 : 0];
    const offset = eye.set(0.032, 0.085, -0.085).applyQuaternion(q.clone().multiply(restQ.clone().invert()));
    const eyeWorld = offset.add(headWorld);
    const local = gun.worldToLocal(eyeWorld.clone());
    const muzzle = soldier.muzzleWorld(eyeWorld.clone());
    const round = (v) => +v.toFixed(3);
    void rest;
    return { eyeInGun: [round(local.x), round(local.y), round(local.z)], eyeWorld: [round(eyeWorld.x), round(eyeWorld.y), round(eyeWorld.z)], head: [round(headWorld.x), round(headWorld.y), round(headWorld.z)], muzzle: muzzle.toArray().map(round) };
  });
  process.stdout.write(`${query} ${JSON.stringify(result)}\n`);
}
await browser.close();
