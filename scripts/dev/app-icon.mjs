// Draws the Mac app icon and builds every size from it.
// Usage: node scripts/dev/app-icon.mjs
// Writes src-tauri/icons/source.png, then `tauri icon` makes icon.icns and the PNG sizes.
// The mark is the favicon's reticle on the off-black ground, in the Apple icon grid
// (824 px body on a 1024 px canvas).
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const icons = join(root, 'src-tauri', 'icons');
const source = join(icons, 'source.png');

const GROUND = '#0E0E0D';
const INK = '#F2F0EA';
const ACCENT = '#4C8DFF';
const C = 512;
const RING = 168;
const TICK_FROM = 236;
const TICK_TO = 300;

const tick = (dx, dy) =>
  `<line x1="${C + dx * TICK_FROM}" y1="${C + dy * TICK_FROM}" x2="${C + dx * TICK_TO}" y2="${C + dy * TICK_TO}"/>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="100" y="100" width="824" height="824" rx="185" fill="${GROUND}"/>
  <rect x="102" y="102" width="820" height="820" rx="183" fill="none" stroke="${INK}" stroke-opacity="0.10" stroke-width="4"/>
  <g fill="none" stroke="${INK}" stroke-width="20" stroke-linecap="butt">
    <circle cx="${C}" cy="${C}" r="${RING}"/>
    ${tick(0, -1)}${tick(1, 0)}${tick(0, 1)}${tick(-1, 0)}
  </g>
  <circle cx="${C}" cy="${C}" r="22" fill="${ACCENT}"/>
</svg>`;

await mkdir(icons, { recursive: true });
await sharp(Buffer.from(svg)).png().toFile(source);
execFileSync('npx', ['tauri', 'icon', source, '--output', icons], { cwd: root, stdio: 'inherit' });
// `tauri icon` also writes Windows Store, Android and iOS sizes. This is a Mac app: keep what the bundle lists.
const KEEP = new Set(['source.png', 'icon.icns', 'icon.ico', 'icon.png', '32x32.png', '128x128.png', '128x128@2x.png']);
for (const name of await readdir(icons)) {
  if (!KEEP.has(name)) await rm(join(icons, name), { recursive: true });
}
process.stdout.write(`${source}\n`);
