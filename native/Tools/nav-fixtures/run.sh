#!/usr/bin/env bash
# nav-fixtures: regenerate native/Contract/nav from src/ai (M7b): nav grids and bot logic fixtures.
#   run.sh          write native/Contract/nav
#   run.sh --check  fail if native/Contract/nav differs from what src/ produces now
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
if [[ "${1:-}" == "--check" ]]; then export NAV_FIXTURES_CHECK=1; fi
exec npx vitest run --config native/Tools/vitest.config.ts native/Tools/nav-fixtures/export.test.ts native/Tools/nav-fixtures/ai.test.ts
