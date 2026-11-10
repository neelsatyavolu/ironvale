// Download helper for the guns-c processing scripts: fetches a file into .cache once.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function download(url, file) {
  if (existsSync(file)) return file;
  await mkdir(dirname(file), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
  return file;
}
