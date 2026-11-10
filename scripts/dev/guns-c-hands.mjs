// Contact sheet of both hands on a gun, for tuning grips and finger curls.
// Usage: node scripts/dev/guns-c-hands.mjs [gun] [extra params] [support|trigger|both]
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const gun = process.argv[2] ?? 'm4a1';
const extra = process.argv[3] ? `&${process.argv[3]}` : '';
// Grip positions in the view: hip pose plus each gun's grip offsets.
const targets = { m4a1: ['0.2,-0.13,-0.75', '0.21,-0.17,-0.46'], m249: ['0.2,-0.18,-0.75', '0.21,-0.18,-0.46'] }[gun];
const base = `view=weapons/models/arms&floor=-1.2&gun=${gun}&fov=45${extra}`;
const sheet = (name, at, angles) =>
  execFileSync(
    'node',
    [join(here, 'guns-c-sheet.mjs'), `guns-hands-${gun}-${name}`, '2', ...angles.map(([yaw, pitch]) => `${base}&yaw=${yaw}&pitch=${pitch}&dist=0.3&at=${at}`)],
    { stdio: 'inherit' },
  );
const which = process.argv[4] ?? 'both';
if (which !== 'trigger') sheet('support', targets[0], [[180, 5], [-90, 10], [90, 10], [200, -50]]);
if (which !== 'support') sheet('trigger', targets[1], [[-90, 5], [90, 5], [180, -10], [20, 45]]);
