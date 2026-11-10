// Writes CREDITS.md from the asset manifests, with the same code the in-game Credits screen uses.
//   node scripts/credits.mjs
// Needs Node 22.18 or newer (it imports a TypeScript file directly).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCredits, creditsMarkdown } from '../src/ui/credits-model.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = readdirSync(join(root, 'assets'))
  .filter((name) => name.endsWith('.json'))
  .sort()
  .flatMap((name) => JSON.parse(readFileSync(join(root, 'assets', name), 'utf8')).assets);

const missing = manifest.filter((entry) => entry.license !== 'CC0' && !entry.credit);
if (missing.length > 0) {
  process.stderr.write(`No credit line for: ${missing.map((entry) => entry.id).join(', ')}\n`);
  process.exit(1);
}
writeFileSync(join(root, 'CREDITS.md'), creditsMarkdown(buildCredits(manifest)));
process.stdout.write(`CREDITS.md written from ${manifest.length} manifest entries\n`);
