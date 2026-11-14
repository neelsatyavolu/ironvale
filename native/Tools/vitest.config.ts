// Vitest config for the native port's Node tools (PLAN.md 5.2). It starts from the root Vite
// config, so `src/` modules resolve exactly as they do for `tests/`, and runs only native/Tools.
import { fileURLToPath } from 'node:url';
import rootConfig from '../../vite.config.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default {
  ...(rootConfig as Record<string, unknown>),
  root: repoRoot,
  test: {
    environment: 'node',
    include: ['native/Tools/**/*.test.ts'],
    testTimeout: 120_000,
  },
};
