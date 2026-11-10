// Renders several viewer shots and tiles them into one contact sheet.
// Usage: node scripts/dev/guns-c-sheet.mjs <sheet-name> <cols> "<params 1>" "<params 2>" ...
// Each shot is also kept as shots/<sheet-name>-<n>.png.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const [name, colsText, ...shots] = process.argv.slice(2);
const cols = Number(colsText);
const W = 960;
const H = 540;
const tiles = [];
/** A stalled capture still writes a file: one flat colour. */
async function blank(file) {
  const { channels } = await sharp(file).stats();
  return channels.every((channel) => channel.stdev < 2);
}
for (const [index, params] of shots.entries()) {
  const out = `${name}-${index + 1}`;
  const shoot = () =>
    execFileSync('node', [join(root, 'scripts/shot.mjs'), '--out', out, '--params', params, '--size', `${W}x${H}`, '--wait', '1800'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  // The GPU is shared with other headless browsers: a capture can throw, or come back blank.
  let log = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      log = shoot();
      if (!(await blank(join(root, 'shots', `${out}.png`)))) break;
      log = '';
    } catch {
      log = '';
    }
  }
  if (!log) process.stdout.write(`${out}: FAILED to capture (blank or no frame after 4 tries)\n`);
  const problems = log.split('\n').slice(3).filter((line) => line && !line.includes('404'));
  if (problems.length) process.stdout.write(`${out}: ${problems.join(' | ')}\n`);
  tiles.push({ input: join(root, 'shots', `${out}.png`), left: (index % cols) * W, top: Math.floor(index / cols) * H });
}
const rows = Math.ceil(shots.length / cols);
const file = join(root, 'shots', `${name}.jpg`);
await sharp({ create: { width: cols * W, height: rows * H, channels: 3, background: '#000' } }).composite(tiles).jpeg({ quality: 88 }).toFile(file);
process.stdout.write(`${file}\n`);
