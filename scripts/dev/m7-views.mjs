// Review sheets of the M7 in the model viewer: shots/m7-profile.jpg (both sides, top, front and rear
// three-quarter), shots/m7-detail.jpg (receiver, handguard, suppressor, stock) and shots/m7-reload.jpg
// (the magazine dropping out of its well).
// Usage: node scripts/dev/m7-views.mjs [profile|detail|reload ...]   (needs npm run dev)
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const base = 'view=weapons/models/m7&floor=-0.6&bg=sky&markers=0&fov=30';
// The viewer's sun is on the right, so views of the left side turn the gun round instead of the camera.
const left = 'turn=180';
const reload = `${base}&yaw=90&pitch=4&dist=0.62&at=0,0.04,-0.1&cycle=1`;
const sheets = {
  profile: [
    `${base}&yaw=90&pitch=0&dist=1.75&at=0,0.06,-0.18`,
    `${base}&${left}&yaw=90&pitch=0&dist=1.75&at=0,0.06,0.18`,
    `${base}&yaw=0&pitch=89&dist=1.75&at=0,0.06,-0.18`,
    `${base}&yaw=140&pitch=16&dist=1.3&at=0,0.06,-0.2`,
    `${base}&yaw=40&pitch=16&dist=1.3&at=0,0.06,-0.15`,
    `${base}&${left}&yaw=40&pitch=16&dist=1.3&at=0,0.06,0.2`,
  ],
  detail: [
    `${base}&yaw=90&pitch=2&dist=0.62&at=0,0.07,-0.06`,
    `${base}&${left}&yaw=90&pitch=2&dist=0.62&at=0,0.07,0.08`,
    `${base}&yaw=110&pitch=14&dist=0.6&at=0,0.1,-0.33`,
    `${base}&yaw=120&pitch=10&dist=0.5&at=0,0.1,-0.55`,
    `${base}&yaw=60&pitch=12&dist=0.6&at=0,0.08,0.17`,
    `${base}&${left}&yaw=110&pitch=24&dist=0.55&at=0,0.1,0.14`,
  ],
  // The magazine leaving its well with the bolt held back: seated, half out, clear.
  reload: [`${reload}&mag=0`, `${reload}&mag=0.05`, `${reload}&mag=0.1`, `${reload}&mag=0.16`],
};
const wanted = process.argv.slice(2);
for (const [name, shots] of Object.entries(sheets)) {
  if (wanted.length && !wanted.includes(name)) continue;
  execFileSync('node', [join(here, 'guns-c-sheet.mjs'), `m7-${name}`, '2', ...shots], { stdio: 'inherit' });
}
