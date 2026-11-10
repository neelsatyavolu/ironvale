// Renders the side-on gun pictures the weapon picker shows, into public/assets/weapons/<id>.webp.
// Usage: node scripts/dev/gun-pictures.mjs   (needs npm run dev)
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import sharp from 'sharp';

// Overall length in metres and how far forward of the grip the middle of the gun sits.
const GUNS = { m4a1: [0.84, 0.12], m1garand: [1.1, 0.2], mp5: [0.68, 0.08], r870: [1.1, 0.2], m24: [1.15, 0.2], m249: [1.04, 0.18], m1911: [0.22, 0.04] };
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 480 } });
await mkdir('public/assets/weapons', { recursive: true });
for (const [id, [length, forward]] of Object.entries(GUNS)) {
  const query = `view=weapons/models/side&gun=${id}&yaw=90&pitch=0&dist=${(length * 1.05).toFixed(2)}&at=0,0.02,${-forward}&floor=-60&fov=40&no=grain,bloom`;
  await page.goto(`http://127.0.0.1:5311/?${query}`);
  await page.waitForFunction(() => window.__ironvale?.ready || window.__ironvale?.error, null, { timeout: 60000 });
  await page.waitForTimeout(1200);
  const shot = await page.screenshot();
  // The backdrop is a flat dark grey: make it transparent so the picture sits on any panel.
  const { data, info } = await sharp(shot).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [br, bg, bb] = [data[0], data[1], data[2]];
  for (let i = 0; i < data.length; i += 4) {
    const distance = Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb);
    data[i + 3] = Math.min(255, Math.max(0, (distance - 6) * 20));
  }
  await sharp(data, { raw: info }).trim().resize({ width: 720, withoutEnlargement: true }).webp({ quality: 88 }).toFile(`public/assets/weapons/${id}.webp`);
  process.stdout.write(`${id} `);
}
await browser.close();
process.stdout.write('\n');
