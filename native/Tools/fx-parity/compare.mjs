#!/usr/bin/env node
// Native side of the M9 FX parity check: renders each pose of native/Parity/<map>-poses.json with the
// app's --capture and --fx switches (with --scene, replaying the events the web capture wrote next to
// its PNG: --fx-events), and scores each against the web capture with SSIM (../m3-parity/ssim.mjs).
//
// Usage: node native/Tools/fx-parity/compare.mjs --app PATH/Ironvale.app --map ID --web DIR --out DIR [--scene] [--app-args "..."]
// Prints one line per pose and writes <out>/<map>-ssim.json ({poses, mean, min}).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ssim } from '../m3-parity/ssim.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const app = value('app');
const mapId = value('map') ?? 'railyard';
const web = resolve(value('web') ?? join(repo, 'native/Parity/m9fx/web'));
const out = resolve(value('out') ?? join(repo, 'native/Parity/m9fx/native'));
const scene = args.includes('--scene');
const appArgs = (value('app-args') ?? '').split(/\s+/).filter(Boolean);
if (!app) throw new Error('--app PATH is required');
const binary = join(app, 'Contents/MacOS/Ironvale');
const { poses } = JSON.parse(readFileSync(join(repo, `native/Parity/${mapId}-poses.json`), 'utf8'));

mkdirSync(out, { recursive: true });
const results = {};
for (const [name, pose] of Object.entries(poses)) {
  const reference = join(web, `${mapId}-${name}.png`);
  if (!existsSync(reference)) throw new Error(`missing web capture ${reference} (run capture-web.mjs)`);
  const file = join(out, `${mapId}-${name}.png`);
  const fx = ['--fx'];
  if (scene) {
    const events = join(web, `${mapId}-${name}.events.json`);
    if (!existsSync(events)) throw new Error(`missing ${events} (run capture-web.mjs --scene)`);
    fx.push('--fx-events', events);
  }
  execFileSync(binary, ['--map', mapId, '--pose', pose.join(','), '--capture', file, '--repo', repo, ...fx, ...appArgs], { stdio: 'inherit' });
  results[name] = await ssim(reference, file);
  console.log(`${mapId.padEnd(10)} ${name.padEnd(10)} SSIM ${results[name].toFixed(4)}`);
}
const values = Object.values(results);
const summary = { poses: results, mean: values.reduce((s, v) => s + v, 0) / values.length, min: Math.min(...values) };
writeFileSync(join(out, `${mapId}-ssim.json`), JSON.stringify(summary, null, 2) + '\n');
console.log(`${mapId.padEnd(10)} ${'min'.padEnd(10)} SSIM ${summary.min.toFixed(4)}  mean ${summary.mean.toFixed(4)}`);
