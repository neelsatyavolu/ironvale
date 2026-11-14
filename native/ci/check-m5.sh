#!/usr/bin/env bash
# M5 exit check (PLAN.md section 7, M5 row; 5.4 layer 3).
#   1. net fixtures --check: native/Tools/interop/fixtures matches what src/net produces now
#   2. typecheck of native/Tools
#   3. swift test for IronvaleNet and IronvaleTransportWebRTC (fixtures, lobby flow, back-to-back WebRTC)
#   4. local relays from the unchanged signaling/src (wrangler dev, native/Tools/interop/wrangler.interop*.jsonc)
#   5. layer 3: ivpeer against the web's NetSession (node-peer.ts) through the local relay, both host
#      roles x room and copy-and-paste codes: lobby, load, go, 10 s of 30 Hz state, shots under the
#      WeaponGate, hits under the cap, death, grenade, chat, away, bye; zero rejections, identical
#      event sequences, native candidates <= 24, native invite/reply codes < 6000 characters;
#      plus native error reporting (no-room, refused origin, rate-limited at the production limit)
#
# The native client sends Origin app://ironvale (owner decision W6). Only the local relays accept it
# until W6 is deployed; the deployed-relay smoke test is native/Tools/interop/smoke-deployed.sh.
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$NATIVE/.." && pwd)"
INTEROP="$NATIVE/Tools/interop"
SCRATCH="${SCRATCH:-$NATIVE/IronvaleKit/.build-m5}"
PORT="${M5_RELAY_PORT:-8790}"
RATE_PORT="${M5_RATELIMIT_PORT:-8791}"
LOGS="$INTEROP/out"

step() { printf '\n== %s\n' "$*"; }

RELAY_PIDS=()
kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}
cleanup() { for pid in "${RELAY_PIDS[@]:-}"; do [[ -n "$pid" ]] && kill_tree "$pid"; done; }
trap cleanup EXIT

start_relay() {
  local port=$1 config=$2 name=$3
  if curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    echo "FAIL: port $port is already serving; stop it or set M5_RELAY_PORT / M5_RATELIMIT_PORT" >&2
    exit 1
  fi
  "$INTEROP/relay.sh" "$port" "$config" >"$LOGS/relay-$name.log" 2>&1 &
  RELAY_PIDS+=($!)
  for _ in $(seq 1 120); do
    curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "FAIL: relay $name did not come up on $port; see $LOGS/relay-$name.log" >&2
  exit 1
}

mkdir -p "$LOGS"

step "interop dependencies"
[[ -d "$INTEROP/node_modules/node-datachannel" ]] || (cd "$INTEROP" && npm ci --no-audit --no-fund)
[[ -x "$ROOT/signaling/node_modules/.bin/wrangler" ]] || (cd "$ROOT/signaling" && npm ci --no-audit --no-fund)

step "net fixtures --check"
(cd "$ROOT" && NET_FIXTURES_CHECK=1 npx vitest run --config native/Tools/vitest.config.ts native/Tools/interop/net-fixtures.test.ts)

step "typecheck native/Tools"
(cd "$ROOT" && npx tsc --noEmit -p native/Tools/tsconfig.json)

step "swift test (IronvaleNet, IronvaleTransportWebRTC)"
(cd "$NATIVE/IronvaleKit" && swift test --scratch-path "$SCRATCH" --filter 'IronvaleNetTests|IronvaleTransportWebRTCTests')

step "swift build ivpeer"
(cd "$NATIVE/IronvaleKit" && swift build --scratch-path "$SCRATCH" --product ivpeer)
IVPEER="$(cd "$NATIVE/IronvaleKit" && swift build --scratch-path "$SCRATCH" --show-bin-path)/ivpeer"
[[ -x "$IVPEER" ]] || { echo "FAIL: $IVPEER missing" >&2; exit 1; }

step "local relays (signaling/src under wrangler dev)"
start_relay "$PORT" "$INTEROP/wrangler.interop.jsonc" interop
start_relay "$RATE_PORT" "$INTEROP/wrangler.interop-ratelimit.jsonc" ratelimit
echo "relay ws://127.0.0.1:$PORT, production-limit relay ws://127.0.0.1:$RATE_PORT"

step "layer 3: native against web"
(cd "$ROOT" && IRONVALE_INTEROP_SIGNAL="ws://127.0.0.1:$PORT" \
  IRONVALE_INTEROP_RATELIMIT_SIGNAL="ws://127.0.0.1:$RATE_PORT" \
  IRONVALE_IVPEER="$IVPEER" IRONVALE_INTEROP_REQUIRED=1 \
  npx vitest run --config native/Tools/vitest.config.ts native/Tools/interop/interop.test.ts)

printf '\nM5 check passed. Peer logs: %s\n' "$LOGS"
