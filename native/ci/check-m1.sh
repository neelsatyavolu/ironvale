#!/usr/bin/env bash
# M1 exit check (PLAN.md section 7): contract extraction and core codecs.
#   1. contract-export --check: native/Contract matches what src/ produces now
#   2. typecheck of native/Tools
#   3. swift test for IronvaleCore, IronvaleContract, IronvaleWire (golden fixtures, ported P0
#      net cases, contract agreement); IronvaleWireTests also writes Contract/out/swift-encoded.json
#   4. reverse codec check (5.4 layer 2): TypeScript decodes what Swift encoded
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$NATIVE/.." && pwd)"
SCRATCH="${SCRATCH:-$NATIVE/IronvaleKit/.build-m1}"

step() { printf '\n== %s\n' "$*"; }

step "contract-export --check"
"$NATIVE/Tools/contract-export/run.sh" --check

step "typecheck native/Tools"
(cd "$ROOT" && npx tsc --noEmit -p native/Tools/tsconfig.json)

step "swift test (Core, Contract, Wire)"
rm -f "$NATIVE/Contract/out/swift-encoded.json"
(cd "$NATIVE/IronvaleKit" && swift test --scratch-path "$SCRATCH" --filter 'IronvaleCoreTests|IronvaleContractTests|IronvaleWireTests')

step "reverse codec check (TypeScript decodes Swift output)"
[[ -f "$NATIVE/Contract/out/swift-encoded.json" ]] || { echo "FAIL: swift test did not write Contract/out/swift-encoded.json" >&2; exit 1; }
(cd "$ROOT" && npx vitest run --config native/Tools/vitest.config.ts native/Tools/contract-export/verify-swift-encoded.test.ts)

printf '\nM1 check passed.\n'
