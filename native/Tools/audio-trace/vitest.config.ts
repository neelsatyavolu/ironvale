// Runs only the audio trace exporter. Root is the repo so `src/` and `assets/` resolve as in the web tests.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('../../..', import.meta.url)),
  test: { environment: 'node', include: ['native/Tools/audio-trace/*.gen.ts'], testTimeout: 120_000 },
} as never);
