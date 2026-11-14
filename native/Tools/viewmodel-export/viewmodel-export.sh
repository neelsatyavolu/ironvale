#!/usr/bin/env bash
# viewmodel-export: regenerate native/Contract/viewmodel.json and fixtures/viewmodel-poses.json from
# src/weapons/view and src/weapons/models (needs native/MapPackages/guns from map-export).
#   viewmodel-export.sh          write them
#   viewmodel-export.sh --check  fail if they differ from what src/ produces now
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
if [[ "${1:-}" == "--check" ]]; then export VIEWMODEL_EXPORT_CHECK=1; fi
exec npx vitest run --config native/Tools/vitest.config.ts native/Tools/viewmodel-export/viewmodel-export.test.ts
