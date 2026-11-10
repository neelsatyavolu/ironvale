// Stages the part of the Vite build that the Mac app embeds in its binary.
// Usage: node scripts/dev/app-stage.mjs   (after `vite build`; `tauri build` runs it)
// Copies dist/ to src-tauri/web/ without the heavy game files. Those ship as
// plain files in the bundle's Resources folder (bundle.resources in
// src-tauri/tauri.conf.json) and are served by src-tauri/src/assets.rs.
import { cp, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(root, 'dist');
const web = join(root, 'src-tauri', 'web');
/** Keep in step with ON_DISK in src-tauri/src/assets.rs. */
const ON_DISK = ['assets/dl', 'assets/local'];

await stat(join(dist, 'index.html')).catch(() => {
  throw new Error('dist/index.html is missing: run `npm run build` first');
});
await rm(web, { recursive: true, force: true });
await cp(dist, web, {
  recursive: true,
  filter: (source) => !ON_DISK.includes(relative(dist, source).split(sep).join('/')),
});

async function size(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += (await stat(join(entry.parentPath, entry.name))).size;
  }
  return total;
}
process.stdout.write(`${web}: ${((await size(web)) / 1e6).toFixed(1)} MB embedded\n`);
