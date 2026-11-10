// Developer aid: print how sources split on silence.
// node scripts/audio/inspect.mjs <key,key> [thresholdDb] [minGap] [maxShown] [minLength]
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSources } from './download.mjs';
import { centroid, cut, decode, duration, peak, segments, toDb } from './dsp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const paths = await fetchSources(join(root, '.cache', 'audio'), () => undefined);
const [keys, threshold = '-32', gap = '0.08', max = '40', minLength = '0.03'] = process.argv.slice(2);
for (const key of keys.split(',')) {
  if (!paths[key]) { process.stdout.write(`${key}: unknown\n`); continue; }
  const clip = decode(paths[key], 1);
  const found = segments(clip, { thresholdDb: Number(threshold), minGap: Number(gap), minLength: Number(minLength) });
  const parts = found.slice(0, Number(max)).map((s, i) => `${i}:${s.start.toFixed(2)}+${(s.end - s.start).toFixed(2)}/${s.peakDb.toFixed(0)}/${Math.round(centroid(cut(clip, s.start, s.end)) / 100)}`);
  process.stdout.write(`${key}: ${duration(clip).toFixed(1)}s pk ${toDb(peak(clip)).toFixed(1)} n=${found.length} [i:start+len/peakDb/centroid*100Hz]\n  ${parts.join('  ')}\n`);
}
