// Fetches every source recording into .cache/audio and unpacks the firearm library.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FFSL, FFSL_FILES, FREESOUND } from './sources.mjs';

const USER_AGENT = 'Mozilla/5.0 (asset fetch script)';
const PARALLEL = 4;

async function download(url, file, attempts = 4) {
  if (existsSync(file) && statSync(file).size > 0) return false;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await writeFile(file, Buffer.from(await response.arrayBuffer()));
      return true;
    } catch (error) {
      if (attempt >= attempts) throw new Error(`Could not download ${url}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
}

function hasBinary(name) {
  return spawnSync('which', [name]).status === 0;
}

/** 7z or 7zz when installed; macOS tar (libarchive) reads 7z too; then the optional 7zip-bin package. */
async function extract7z(archive, outDir) {
  for (const tool of ['7zz', '7z']) {
    if (hasBinary(tool)) return void execFileSync(tool, ['x', '-y', `-o${outDir}`, archive], { stdio: 'ignore' });
  }
  const tar = spawnSync('tar', ['-xf', archive, '-C', outDir], { stdio: 'ignore' });
  if (tar.status === 0) return;
  try {
    const { path7za } = await import('7zip-bin');
    execFileSync(path7za, ['x', '-y', `-o${outDir}`, archive], { stdio: 'ignore' });
  } catch (error) {
    throw new Error(`No way to unpack ${archive}: install 7zz (brew install sevenzip) or "npm i -D 7zip-bin". ${error.message}`);
  }
}

/** Returns key -> absolute path for every source. */
export async function fetchSources(cacheDir, log) {
  const srcDir = join(cacheDir, 'src');
  const ffslDir = join(cacheDir, 'ffsl');
  mkdirSync(srcDir, { recursive: true });
  mkdirSync(ffslDir, { recursive: true });
  const paths = {};

  const jobs = Object.entries(FREESOUND);
  let next = 0;
  let fetched = 0;
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      while (next < jobs.length) {
        const [key, source] = jobs[next++];
        const file = join(srcDir, source.file);
        if (await download(source.url, file)) fetched++;
        paths[key] = file;
      }
    }),
  );
  log(`freesound: ${jobs.length} sources (${fetched} downloaded now)`);

  const missing = Object.values(FFSL_FILES).some((inner) => !existsSync(join(ffslDir, FFSL.dir, inner)));
  if (missing) {
    const archive = join(cacheDir, FFSL.archive);
    if (!existsSync(archive) || statSync(archive).size !== FFSL.bytes) {
      log('firearm library: downloading 194 MB');
      await download(FFSL.url, archive);
    }
    log('firearm library: unpacking');
    await extract7z(archive, ffslDir);
  }
  for (const [key, inner] of Object.entries(FFSL_FILES)) {
    const file = join(ffslDir, FFSL.dir, inner);
    if (!existsSync(file)) throw new Error(`Firearm library file missing after unpack: ${inner}`);
    paths[key] = file;
  }
  return paths;
}
