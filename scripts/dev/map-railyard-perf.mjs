// Runs review-perf-bench.mjs for the Railyard map against a dev server on another port, so a
// baseline checkout and the working tree can be measured side by side.
// Usage: node scripts/dev/map-railyard-perf.mjs <port> [options for review-perf-bench.mjs]
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [port = '5311', ...rest] = process.argv.slice(2);
const source = readFileSync(join(here, 'review-perf-bench.mjs'), 'utf8').replaceAll('127.0.0.1:5311', `127.0.0.1:${port}`);
const copy = join(here, `.map-railyard-perf-${port}.mjs`);
writeFileSync(copy, source);
try {
  const result = spawnSync(process.execPath, [copy, '--maps', 'railyard', '--tiers', 'high', '--toggles', '0', '--sizes', '1728x1117', ...rest], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(copy, { force: true });
}
