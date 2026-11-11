// Renders the side-on gun pictures the weapon picker shows, into public/assets/weapons/<id>.webp.
// Usage: node scripts/dev/gun-pictures.mjs [id ...]   (needs npm run dev; no ids: every gun)
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import sharp from 'sharp';

// Overall length in metres and how far forward of the grip the middle of the gun sits.
const GUNS = { m4a1: [0.84, 0.12], mp5: [0.68, 0.08], m24: [1.15, 0.2], m249: [1.04, 0.18], m7: [0.914, 0.18] };
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 480 }, deviceScaleFactor: 2 });
await mkdir('public/assets/weapons', { recursive: true });
const wanted = process.argv.slice(2);
for (const [id, [length, forward]] of Object.entries(GUNS)) {
  if (wanted.length && !wanted.includes(id)) continue;
  const query = `view=weapons/models/side&gun=${id}&yaw=90&pitch=0&dist=${(length * 1.05).toFixed(2)}&at=0,0.02,${-forward}&floor=-60&fov=40&bgcolor=00ff00&no=grain,bloom,ao,ssr,godrays`;
  await page.goto(`http://127.0.0.1:5311/?${query}`);
  await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 60000 });
  await page.waitForTimeout(1200);
  const shot = await page.screenshot();
  // The backdrop is a flat green key colour, far from every colour on a gun: cut it out so the
  // picture sits on any panel, and pull the green spill off the edge pixels.
  const { data, info } = await sharp(shot).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    // Green dominance, not distance from one colour: the vignette darkens the backdrop unevenly.
    const dominance = data[i + 1] / Math.max(data[i], data[i + 2], 8);
    data[i + 3] = Math.round(255 * Math.min(1, Math.max(0, (1.6 - dominance) * 2.5)));
    data[i + 1] = Math.min(data[i + 1], Math.max(data[i], data[i + 2]) + 6);
  }
  await sharp(data, { raw: info }).trim().resize({ width: 1200, withoutEnlargement: true }).webp({ quality: 88 }).toFile(`public/assets/weapons/${id}.webp`);
  process.stdout.write(`${id} `);
}
await browser.close();
process.stdout.write('\n');
