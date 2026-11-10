// Contact sheet of one gait through a full stride, side and front.
// Usage: node scripts/dev/characters-cycle.mjs <sheet-name> <state> [frames=8] [extra query]
// Writes shots/characters-<sheet-name>.png (side view on top, front view below).
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [sheet, state, frames = '8', extra = ''] = process.argv.slice(2);
const SPEED = { walk: 1.7, jog: 3.4, run: 5.2, crouchwalk: 1.8, aimwalk: 1.7 };
// Seconds for one full stride at the state's speed, from the baked clip table.
const meta = await import(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'characters', 'clip-meta.ts'));
const clip = { walk: 'walk', aimwalk: 'walk', jog: 'jog', run: 'run', crouchwalk: 'crouchJog' }[state];
const period = (meta.CLIP_META[clip].speed * meta.CLIP_META[clip].duration) / SPEED[state];
const count = Number(frames);
const camera = state.startsWith('crouch') ? 'at=0,0.7,0&dist=3.4&pitch=6' : 'at=0,0.95,0&dist=3.8&pitch=6';
const queries = [];
for (const yaw of [90, 0]) {
  for (let i = 0; i < count; i++) queries.push(`state=${state}&t=${(1 + (i / count) * period).toFixed(3)}&yaw=${yaw}&${camera}${extra ? `&${extra}` : ''}`);
}
const out = execFileSync('node', [join(dirname(fileURLToPath(import.meta.url)), 'characters-shots.mjs'), sheet, queries.join(';'), '--cols', String(count), '--size', '225x400', '--wait', '700'], { encoding: 'utf8' });
process.stdout.write(out.split('\n').filter((line) => !line.includes('favicon')).join('\n'));
