#!/usr/bin/env bash
# sim-fixtures: regenerate native/Contract/sim from src/ (M4; PLAN.md 5.4 layer 1).
#   run.sh          write native/Contract/sim
#   run.sh --check  fail if native/Contract/sim differs from what src/ produces now
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
if [[ "${1:-}" == "--check" ]]; then export SIM_FIXTURES_CHECK=1; fi
exec npx vitest run --config native/Tools/vitest.config.ts native/Tools/sim-fixtures/export.test.ts
