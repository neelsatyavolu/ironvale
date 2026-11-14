#!/usr/bin/env bash
# characters-export: regenerate native/Contract/characters.json and the soldier fixtures from src/characters.
#   characters-export.sh          write them
#   characters-export.sh --check  fail if they differ from what src/ produces now
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
if [[ "${1:-}" == "--check" ]]; then export CHARACTERS_EXPORT_CHECK=1; fi
exec npx vitest run --config native/Tools/vitest.config.ts native/Tools/asset-bake/characters-export.test.ts
