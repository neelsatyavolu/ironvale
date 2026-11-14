#!/usr/bin/env node
// map-export (PLAN.md 3.5-3.7): runs each map's build() in Chrome through Vite and writes
// native/MapPackages/<id>/ (meta.json, collision.bin, boundary.bin, bvh.bin, fixtures/queries.bin,
// and the git-ignored render/), plus the gun-export GLBs in native/MapPackages/guns/ (git-ignored).
//
// Usage: node native/Tools/map-export/run.mjs [--out DIR] [--maps a,b] [--no-render] [--no-guns] [--check] [--density D]
//   --density D  build the maps at detail density D instead of 1 (packages are committed at 1; other
//            densities exist for the M11 check that collision does not depend on detail).
//   --check  exports collision data to a temporary directory and fails when it differs from the
//            committed packages, or when a playable map has no package.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const packages = join(repo, 'native/MapPackages');
const DEFAULT_MAPS = ['range', 'railyard', 'headworks', 'harbor'];
/** Committed files per package; render/ and guns/ are rebuilt, not committed. */
const COMMITTED = ['meta.json', 'collision.bin', 'boundary.bin', 'bvh.bin', 'fixtures/queries.bin'];

function parseArgs(argv) {
  const args = { out: packages, maps: DEFAULT_MAPS, render: true, guns: true, check: false, density: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = resolve(argv[++i]);
    else if (a === '--maps') args.maps = argv[++i].split(',').filter(Boolean);
    else if (a === '--no-render') args.render = false;
    else if (a === '--no-guns') args.guns = false;
    else if (a === '--check') args.check = true;
    else if (a === '--density') args.density = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!(args.density > 0 && args.density <= 1)) throw new Error('--density must be in (0, 1]');
  if (args.check && args.density !== 1) throw new Error('--check compares the committed density-1 packages; drop --density');
  if (args.check) {
    args.out = mkdtempSync(join(tmpdir(), 'map-export-'));
    args.render = false;
    args.guns = false;
  }
  return args;
}

/** Last commit that changed anything a package is derived from; stable across unrelated commits. */
function sourceCommit() {
  return execFileSync('git', ['log', '-1', '--format=%H', '--', 'src/maps', 'src/world', 'src/core/random.ts', 'package-lock.json'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
}

/** Vite middleware the page posts finished files to. Writes stay inside `out`. */
function writer(out) {
  return {
    name: 'map-export-writer',
    configureServer(server) {
      server.middlewares.use('/__map-export/write', (req, res) => {
        const url = new URL(req.url, 'http://x');
        const rel = url.searchParams.get('path') ?? '';
        const target = resolve(out, rel);
        if (!rel || target === out || !target.startsWith(out + sep) || rel.includes('..')) {
          res.statusCode = 400;
          res.end(`bad path ${rel}`);
          return;
        }
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('error', (e) => {
          res.statusCode = 500;
          res.end(String(e));
        });
        req.on('end', () => {
          try {
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, Buffer.concat(chunks));
            res.end('ok');
          } catch (e) {
            res.statusCode = 500;
            res.end(String(e));
          }
        });
      });
    },
  };
}

async function launch() {
  const args = ['--disable-gpu-sandbox', '--js-flags=--max-old-space-size=8192'];
  try {
    return await chromium.launch({ channel: 'chrome', headless: true, args });
  } catch {
    return await chromium.launch({ headless: true, args });
  }
}

async function openPage(browser, base) {
  const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
  page.on('pageerror', (e) => console.error(`[page error] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error(`[page] ${m.text()}`);
  });
  await page.goto(`${base}native/Tools/map-export/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__mapExport, null, { timeout: 120000 });
  return page;
}

function compare(out, maps, playable) {
  const problems = [];
  for (const id of playable) {
    if (!existsSync(join(packages, id, 'meta.json'))) problems.push(`playable map "${id}" has no package in native/MapPackages`);
  }
  for (const id of maps) {
    for (const file of COMMITTED) {
      const committed = join(packages, id, file);
      const fresh = join(out, id, file);
      if (!existsSync(committed)) problems.push(`${id}/${file}: not committed`);
      else if (!readFileSync(committed).equals(readFileSync(fresh))) problems.push(`${id}/${file}: differs from a fresh export`);
    }
  }
  return problems;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const server = await createServer({
    configFile: join(repo, 'vite.config.ts'),
    root: repo,
    logLevel: 'warn',
    // No watcher or HMR: other agents edit the tree while an export runs, and a reload would kill it.
    server: { host: '127.0.0.1', port: 5390, strictPort: false, hmr: false, watch: null },
    plugins: [writer(args.out)],
  });
  await server.listen();
  const base = server.resolvedUrls.local[0];
  const browser = await launch();
  const commit = sourceCommit();
  let playable = [];
  let failed = false;
  try {
    for (const id of args.maps) {
      const started = Date.now();
      if (!args.check && args.render) rmSync(join(args.out, id, 'render'), { recursive: true, force: true });
      const page = await openPage(browser, base);
      playable = await page.evaluate(() => window.__mapExport.playable);
      const result = await page.evaluate(
        ([mapId, options]) => window.__mapExport.exportMap(mapId, options),
        [id, { sourceCommit: commit, render: args.render, detailDensity: args.density }],
      );
      await page.close();
      const render = result.render ? `, render ${result.render.meshes} meshes ${(result.render.bytes / 1e6).toFixed(1)} MB` : '';
      console.log(
        `${id}: ${result.triangles} triangles, ${result.boundaryTriangles} boundary, sha256 ${result.collisionSha256}${render} (${((Date.now() - started) / 1000).toFixed(1)} s)`,
      );
    }
    if (args.guns) {
      const page = await openPage(browser, base);
      const ids = await page.evaluate(() => window.__mapExport.guns);
      const guns = await page.evaluate((list) => window.__mapExport.exportGuns(list), ids);
      await page.close();
      const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
      for (const id of Object.keys(guns)) {
        const gltfPath = join(args.out, 'guns', `${id}.gltf`);
        const doc = await io.readJSON({ json: JSON.parse(readFileSync(gltfPath, 'utf8')), resources: {} });
        const glb = Buffer.from(await io.writeBinary(doc));
        const sha256 = createHash('sha256').update(glb).digest('hex');
        writeFileSync(join(args.out, 'guns', `${id}.glb`), glb);
        rmSync(gltfPath);
        const infoPath = join(args.out, 'guns', `${id}.json`);
        const info = JSON.parse(readFileSync(infoPath, 'utf8'));
        writeFileSync(infoPath, `${JSON.stringify({ ...info, glbSha256: sha256 }, null, 2)}\n`);
        console.log(`gun ${id}: ${guns[id].nodes} nodes, ${glb.length} bytes, sha256 ${sha256}`);
      }
    }
    if (args.check) {
      const problems = compare(args.out, args.maps, playable);
      for (const p of problems) console.error(`map-export --check: ${p}`);
      failed = problems.length > 0;
      if (!failed) console.log(`map-export --check: ${args.maps.length} packages match (${relative(repo, packages)})`);
    }
  } finally {
    await browser.close();
    await server.close();
    if (args.check) rmSync(args.out, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
