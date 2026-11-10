// Downloads the raw source models for the guns-b weapons (m1garand, m24) into .cache/guns-b/.
// m1garand: "M1 Garand ( US Rifle, Caliber .30, M1)" by Sky_Hunter, CC BY 4.0, from the Objaverse mirror.
// m24: "R700V2" by Domevans, CC BY 4.0, from the Objaverse mirror
// (https://sketchfab.com/3d-models/r700v2-d748f463852144c7a982b3e170e7d000).
// Usage: node scripts/fetch-guns-b.mjs
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, '.cache', 'guns-b');
const OBJ = 'https://huggingface.co/datasets/allenai/objaverse/resolve/main/glbs';

const files = [
  [`${OBJ}/000-067/1be4bb0f8c05423abdccb50b779de6e6.glb`, 'garand-skyhunter/source.glb'],
  [`${OBJ}/000-048/d748f463852144c7a982b3e170e7d000.glb`, 'r700-domevans/source.glb'],
];

for (const [url, path] of files) {
  const target = join(cache, path);
  const existing = await stat(target).catch(() => null);
  if (existing && existing.size > 0) {
    process.stdout.write(`have ${path} (${existing.size})\n`);
    continue;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  process.stdout.write(`got  ${path} (${bytes.length})\n`);
}
