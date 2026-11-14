#!/usr/bin/env bash
# contract-export: regenerate native/Contract from src/ (PLAN.md 5.2).
#   run.sh          write native/Contract
#   run.sh --check  fail if native/Contract differs from what src/ produces now
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
if [[ "${1:-}" == "--check" ]]; then export CONTRACT_EXPORT_CHECK=1; fi
exec npx vitest run --config native/Tools/vitest.config.ts native/Tools/contract-export/export.test.ts
