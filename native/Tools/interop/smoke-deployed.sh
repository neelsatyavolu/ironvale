#!/usr/bin/env bash
# Nightly smoke test against the DEPLOYED relay (PLAN.md section 7, M5 row): ivpeer hosts a room,
# the Node reference peer joins as the web guest, and they run the layer 3 script (10 s of state
# and more); a second run restricts ivpeer to TURN candidates (iceTransportPolicy = relay).
#
# REQUIRES W6 (PLAN.md 13, Q2): the deployed relay must accept Origin app://ironvale. Until the
# owner deploys W6 this script stops with exit code 3 before opening any room. It never deploys
# or changes the relay.
#   smoke-deployed.sh [RELAY_URL]   default wss://ironvale-signal.n3el.dev
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
NATIVE="$(cd "$HERE/../.." && pwd)"
ROOT="$(cd "$NATIVE/.." && pwd)"
RELAY="${1:-wss://ironvale-signal.n3el.dev}"
HTTP="${RELAY/#ws/http}"
SCRATCH="${SCRATCH:-$NATIVE/IronvaleKit/.build-m5}"

status="$(curl -s -o /dev/null -w '%{http_code}' -m 5 -H 'Origin: app://ironvale' "$HTTP/ice" || true)"
if [[ "$status" != "200" ]]; then
  echo "smoke-deployed: $HTTP/ice answered $status to Origin app://ironvale; W6 is not deployed, nothing to test." >&2
  exit 3
fi

(cd "$NATIVE/IronvaleKit" && swift build --scratch-path "$SCRATCH" --product ivpeer)
IVPEER="$(cd "$NATIVE/IronvaleKit" && swift build --scratch-path "$SCRATCH" --show-bin-path)/ivpeer"
[[ -d "$HERE/node_modules/node-datachannel" ]] || (cd "$HERE" && npm ci --no-audit --no-fund)
cd "$ROOT"
IRONVALE_SMOKE_SIGNAL="$RELAY" IRONVALE_IVPEER="$IVPEER" \
  npx vitest run --config native/Tools/vitest.config.ts native/Tools/interop/interop.test.ts -t 'deployed relay smoke'
