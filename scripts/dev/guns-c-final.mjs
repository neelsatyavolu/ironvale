// Takes the review screenshots for the guns-c guns and the arms: shots/guns-<id>-<angle>.png.
// Usage: node scripts/dev/guns-c-final.mjs [m4a1|m249|m7|arms ...]
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const shot = join(here, '../shot.mjs');
/** A stalled capture still writes a file: one flat colour. The page log cannot tell, the pixels can. */
async function blank(name) {
  const { channels } = await sharp(join(here, '../../shots', `${name}.png`)).stats();
  return channels.every((channel) => channel.stdev < 2);
}
const wanted = process.argv.slice(2);
const gun = (id) => {
  const base = `view=weapons/models/${id}&floor=-0.5&bg=sky`;
  const side = 'pitch=3&dist=1.0&at=0,0.06,-0.16';
  return {
    left: `${base}&yaw=-90&${side}`,
    right: `${base}&yaw=90&${side}`,
    top: `${base}&yaw=0&pitch=89&dist=1.0&at=0,0.06,-0.16`,
    threequarter: `${base}&yaw=140&pitch=18&dist=0.7&at=0,0.08,-0.15&markers=0`,
    sight: `${base}&aim=1&cam=0,0,0&look=0,0,-1&fov=50&markers=0`,
  };
};
const arms = 'view=weapons/models/arms&floor=-1.4&bg=sky';
const sets = {
  m4a1: gun('m4a1'),
  m249: gun('m249'),
  m7: gun('m7'),
  arms: {
    fp: `${arms}&cam=0,0,0&look=0,0,-1&fov=78`,
    aim: `${arms}&aim=1&cam=0,0,0&look=0,0,-1&fov=56`,
    outside: `${arms}&yaw=70&pitch=12&dist=1.0&at=0.1,-0.25,-0.4`,
    'outside-left': `${arms}&yaw=-70&pitch=12&dist=1.0&at=0.1,-0.25,-0.4`,
    m249: `${arms}&gun=m249&cam=0,0,0&look=0,0,-1&fov=78`,
    m7: `${arms}&gun=m7&cam=0,0,0&look=0,0,-1&fov=78`,
    'm7-aim': `${arms}&gun=m7&aim=1&cam=0,0,0&look=0,0,-1&fov=56`,
  },
};
for (const [id, views] of Object.entries(sets)) {
  if (wanted.length && !wanted.includes(id)) continue;
  for (const [angle, params] of Object.entries(views)) {
    let log = '';
    // The GPU is shared with other headless browsers, so a capture can stall: try a few times.
    for (let attempt = 0; attempt < 4 && !log; attempt++) {
      try {
        log = execFileSync('node', [shot, '--out', `guns-${id}-${angle}`, '--params', params, '--wait', '1800'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        if (await blank(`guns-${id}-${angle}`)) log = '';
      } catch {
        log = '';
      }
    }
    if (!log) {
      process.stdout.write(`guns-${id}-${angle} FAILED to capture (blank or no frame after 4 tries)\n`);
      continue;
    }
    const problems = log.split('\n').slice(1).filter((line) => line && !line.startsWith('info:') && line !== 'status: ok' && !line.includes('404'));
    process.stdout.write(`guns-${id}-${angle} ${problems.length ? problems.join(' | ') : 'ok'}\n`);
  }
}
