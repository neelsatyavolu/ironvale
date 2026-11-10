// Downloads every file listed in assets/*.json into public/assets/dl.
// Files that already exist are skipped. Usage: npm run assets [-- --only <id-prefix>]
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'assets', 'dl');
const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : null;
const CONCURRENCY = 6;

// Every assets/*.json file is a manifest.
const manifestDir = join(root, 'assets');
const assets = [];
const seen = new Map();
for (const name of (await readdir(manifestDir)).filter((n) => n.endsWith('.json')).sort()) {
  const manifest = JSON.parse(await readFile(join(manifestDir, name), 'utf8'));
  for (const asset of manifest.assets) {
    if (seen.has(asset.id)) throw new Error(`Duplicate asset id "${asset.id}" in ${name} and ${seen.get(asset.id)}`);
    seen.set(asset.id, name);
    assets.push(asset);
  }
}
const jobs = [];
for (const asset of assets) {
  if (only && !asset.id.startsWith(only)) continue;
  for (const [role, file] of Object.entries(asset.files)) {
    // Files marked local are committed under public/assets/local and need no download.
    if (file.local || !file.url) continue;
    jobs.push({ id: asset.id, role, ...file });
  }
}

async function exists(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function download(job) {
  const target = join(outDir, job.path);
  if (await exists(target)) return 'skipped';
  const response = await fetch(job.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length === 0) throw new Error('empty response');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
  return 'downloaded';
}

let downloaded = 0;
let skipped = 0;
const failures = [];
const queue = [...jobs];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        const result = await download(job);
        if (result === 'downloaded') downloaded++;
        else skipped++;
      } catch (error) {
        failures.push(`${job.id} [${job.role}] ${job.url}: ${error.message}`);
      }
    }
  }),
);

process.stdout.write(`assets: ${downloaded} downloaded, ${skipped} already present, ${failures.length} failed\n`);
for (const failure of failures) process.stderr.write(`  FAILED ${failure}\n`);
process.exit(failures.length ? 1 : 0);
