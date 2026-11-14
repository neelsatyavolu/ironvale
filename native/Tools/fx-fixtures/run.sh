#!/usr/bin/env bash
# fx-fixtures: regenerate native/Contract/fx from src/fx (M9 FX; PLAN.md 5.4 layer 1).
#   run.sh          write native/Contract/fx
#   run.sh --check  fail if native/Contract/fx differs from what src/ produces now
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
if [[ "${1:-}" == "--check" ]]; then export FX_FIXTURES_CHECK=1; fi
exec npx vitest run --config native/Tools/vitest.config.ts native/Tools/fx-fixtures/export.test.ts
