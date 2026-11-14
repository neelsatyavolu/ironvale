#!/usr/bin/env node
// Native side of the M3 parity check: renders each pose in native/Parity/railyard-poses.json with
// the app's --capture switch and scores it against the web captures with SSIM (ssim.mjs).
//
// Usage: node native/Tools/m3-parity/compare.mjs --app PATH/Ironvale.app [--web DIR]... [--out DIR] [--app-args "..."] [--map ID]
//   --map picks native/Parity/<ID>-poses.json and the <ID>-<pose>.png names (default railyard).
//   --web may repeat; each directory is scored separately (the first one is the gate).
//   --app-args passes extra launch arguments, e.g. "--q high --no grain" for the M9 post chain.
// Prints one line per pose and the mean; writes <out>/ssim.json.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ssim } from './ssim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const args = process.argv.slice(2);
const values = (name) => args.flatMap((value, i) => (args[i - 1] === `--${name}` ? [value] : []));
const app = values('app')[0];
if (!app) throw new Error('--app PATH is required');
const webDirs = values('web').length ? values('web').map((d) => resolve(d)) : [join(repo, 'native/Parity/web')];
const out = resolve(values('out')[0] ?? join(repo, 'native/Parity/native'));
const binary = join(app, 'Contents/MacOS/Ironvale');
const appArgs = (values('app-args')[0] ?? '').split(/\s+/).filter(Boolean);
const mapId = values('map')[0] ?? 'railyard';
const { poses } = JSON.parse(readFileSync(join(repo, `native/Parity/${mapId}-poses.json`), 'utf8'));

mkdirSync(out, { recursive: true });
const results = {};
for (const [name, pose] of Object.entries(poses)) {
  const file = join(out, `${mapId}-${name}.png`);
  execFileSync(binary, ['--map', mapId, '--pose', pose.join(','), '--capture', file, '--repo', repo, ...appArgs], { stdio: 'inherit' });
  results[name] = {};
  for (const dir of webDirs) {
    const reference = join(dir, `${mapId}-${name}.png`);
    if (!existsSync(reference)) throw new Error(`missing web capture ${reference} (run capture-web.mjs)`);
    results[name][basename(dir)] = await ssim(reference, file);
  }
  console.log(`${name.padEnd(10)} ${webDirs.map((d) => `${basename(d)} ${results[name][basename(d)].toFixed(4)}`).join('  ')}`);
}
const means = Object.fromEntries(
  webDirs.map((d) => [basename(d), Object.values(results).reduce((s, r) => s + r[basename(d)], 0) / Object.keys(results).length]),
);
const minimum = Object.fromEntries(webDirs.map((d) => [basename(d), Math.min(...Object.values(results).map((r) => r[basename(d)]))]));
console.log(`${'mean'.padEnd(10)} ${webDirs.map((d) => `${basename(d)} ${means[basename(d)].toFixed(4)}`).join('  ')}`);
console.log(`${'min'.padEnd(10)} ${webDirs.map((d) => `${basename(d)} ${minimum[basename(d)].toFixed(4)}`).join('  ')}`);
writeFileSync(join(out, 'ssim.json'), JSON.stringify({ poses: results, mean: means, min: minimum }, null, 2) + '\n');
