// Shoots the eight fixed review poses in map-railyard-poses.json through map-railyard-shot.mjs.
// Usage: node scripts/dev/map-railyard-round.mjs <prefix> [extra options for map-railyard-shot.mjs]
// Writes shots/railyard-<prefix>-<pose>.png and prints draw calls, triangles and frame time per pose.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const poses = JSON.parse(readFileSync(join(here, 'map-railyard-poses.json'), 'utf8'));
const [prefix = 'round', ...rest] = process.argv.slice(2);
const only = rest[0] && !rest[0].startsWith('--') ? rest.shift().split(',') : Object.keys(poses);
const poseArgs = only.flatMap((name) => ['--pose', `${name}:${poses[name].join(',')}`]);
const result = spawnSync(process.execPath, [join(here, 'map-railyard-shot.mjs'), '--prefix', `${prefix}-`, ...poseArgs, ...rest], {
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
