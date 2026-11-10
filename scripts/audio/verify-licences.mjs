// Reads every Freesound source page and prints the title, uploader and licence it states,
// so the table in sources.mjs can be checked against the site. Results are cached.
//   node scripts/audio/verify-licences.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FREESOUND } from './sources.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cacheFile = join(root, '.cache', 'audio', 'licences.json');
mkdirSync(dirname(cacheFile), { recursive: true });
const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const decode = (text) => text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function read(page) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await fetch(page, { headers: { 'User-Agent': 'Mozilla/5.0 (licence check)' } });
    if (response.status === 429) {
      await sleep(15000 * attempt);
      continue;
    }
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const html = await response.text();
    const title = html.match(/<meta property="og:audio:title" content="([^"]*)"/)?.[1] ?? html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';
    const licence = html.match(/https?:\/\/creativecommons\.org\/(publicdomain\/zero|licenses\/[a-z-]+)\/[\d.]+/)?.[0] ?? '';
    const user = response.url.match(/people\/([^/]+)\//)?.[1] ?? '';
    return { title: decode(title), licence, user: decodeURIComponent(user) };
  }
  return { error: 'rate limited' };
}

let mismatches = 0;
for (const [key, source] of Object.entries(FREESOUND)) {
  if (!cache[source.page] || cache[source.page].error) {
    cache[source.page] = await read(source.page);
    writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
    await sleep(1300);
  }
  const found = cache[source.page];
  const expected = source.license === 'CC0' ? 'publicdomain/zero' : 'licenses/by/';
  const licenceOk = found.licence?.includes(expected);
  const titleOk = found.title === source.title;
  const userOk = found.user === source.author;
  if (!licenceOk || !titleOk || !userOk) {
    mismatches++;
    process.stdout.write(`${key} | ${source.page} | licence ${found.licence || found.error} ${licenceOk ? 'ok' : 'MISMATCH'} | title "${found.title}"${titleOk ? '' : ` (table: "${source.title}")`} | user ${found.user}${userOk ? '' : ` (table: ${source.author})`}\n`);
  }
}
process.stdout.write(`${Object.keys(FREESOUND).length} sources checked, ${mismatches} differ from the table\n`);
