// Builds the website: the landing page (site/) at the root and the game at /play/.
// Usage: npm run build:site  ->  out/
import { cp, mkdir, rename, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'out');

execFileSync('npx', ['vite', 'build'], { cwd: root, stdio: 'inherit' });
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(join(root, 'site'), out, { recursive: true });
// The game uses relative URLs throughout, so it works from any folder.
await rename(join(root, 'dist'), join(out, 'play'));
process.stdout.write('site built in out/\n');
