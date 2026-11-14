#!/usr/bin/env bash
# M6 exit check (PLAN.md section 7, M6 row; 5.4 layer 4): duel cross-play, the real web build in
# Chrome against the native app, through a local relay running the unchanged signaling/src.
#   1. duel-rules fixtures --check (src/net/rules.ts), then swift test for IronvaleNet (lobby flow,
#      net fixtures, duel rules against those fixtures)
#   2. the app (native/ci/build-app.sh, DERIVED_DATA override honoured)
#   3. Vite dev server on 5311 (reused when one is already serving) and a local relay
#   4. layer 4 duel (native/Tools/interop/duel.mjs) to a 10-kill target on each map in M6_MAPS,
#      native host and web host, M6_RUNS consecutive times: complementary results, agreeing scores,
#      zero rejected shots or hits on either side; in every run the native app loses its display
#      link for 10 s mid-match (as for a hidden window) and the match must carry on (owner decision Q5)
#
# Overrides: SCRATCH (swift scratch path), DERIVED_DATA (app build), M6_APP (skip the build and use
# this Ironvale.app), M6_MAPS (default "railyard headworks"), M6_RUNS (default 5), M6_TARGET
# (default 10), M6_RELAY_PORT (default 8792), M6_VITE_PORT (5311; the relay config only admits 5311).
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$NATIVE/.." && pwd)"
INTEROP="$NATIVE/Tools/interop"
SCRATCH="${SCRATCH:-$NATIVE/IronvaleKit/.build-m6}"
export DERIVED_DATA="${DERIVED_DATA:-$NATIVE/DerivedData-m6}"
MAPS="${M6_MAPS:-railyard headworks}"
RUNS="${M6_RUNS:-5}"
TARGET="${M6_TARGET:-10}"
PORT="${M6_RELAY_PORT:-8792}"
VITE_PORT="${M6_VITE_PORT:-5311}"
LOGS="$INTEROP/out"

step() { printf '\n== %s\n' "$*"; }

PIDS=()
kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}
cleanup() { for pid in "${PIDS[@]:-}"; do [[ -n "$pid" ]] && kill_tree "$pid"; done; }
trap cleanup EXIT

wait_http() {
  local url=$1 what=$2 log=$3
  for _ in $(seq 1 240); do
    curl -sf "$url" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "FAIL: $what did not come up at $url; see $log" >&2
  exit 1
}

mkdir -p "$LOGS"

step "dependencies"
[[ -x "$ROOT/signaling/node_modules/.bin/wrangler" ]] || (cd "$ROOT/signaling" && npm ci --no-audit --no-fund)
[[ -d "$ROOT/node_modules/playwright" ]] || { echo "FAIL: playwright missing; run npm ci at the repo root" >&2; exit 1; }

step "duel-rules fixtures --check"
(cd "$ROOT" && NET_FIXTURES_CHECK=1 npx vitest run --config native/Tools/vitest.config.ts native/Tools/interop/duel-fixtures.test.ts)

step "swift test (IronvaleNet)"
(cd "$NATIVE/IronvaleKit" && swift test --scratch-path "$SCRATCH" --filter 'IronvaleNetTests')

if [[ -n "${M6_APP:-}" ]]; then
  APP="$M6_APP"
else
  step "build the app ($DERIVED_DATA)"
  APP="$("$NATIVE/ci/build-app.sh" | tail -1)"
fi
[[ -x "$APP/Contents/MacOS/Ironvale" ]] || { echo "FAIL: $APP is not an app bundle" >&2; exit 1; }
# Run an isolated copy: other agents stop or hide their own runs by app name or path.
APP="$("$INTEROP/isolate-app.sh" "$APP" "$LOGS/m6-app/IronvaleM6.app")"
echo "app: $APP"

step "Vite dev server on $VITE_PORT"
if curl -sf "http://127.0.0.1:$VITE_PORT/" >/dev/null 2>&1; then
  echo "reusing the server already on $VITE_PORT"
else
  (cd "$ROOT" && npx vite --port "$VITE_PORT" --strictPort >"$LOGS/vite-m6.log" 2>&1) &
  PIDS+=($!)
  wait_http "http://127.0.0.1:$VITE_PORT/" "Vite" "$LOGS/vite-m6.log"
fi

step "local relay on $PORT (signaling/src under wrangler dev)"
if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "FAIL: port $PORT is already serving; stop it or set M6_RELAY_PORT" >&2
  exit 1
fi
"$INTEROP/relay.sh" "$PORT" "$INTEROP/wrangler.interop.jsonc" >"$LOGS/relay-m6.log" 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:$PORT/health" "relay" "$LOGS/relay-m6.log"

step "layer 4 duel: maps [$MAPS], both hosts, $RUNS consecutive runs, first to $TARGET"
SUMMARY="$LOGS/m6-summary.txt"
: >"$SUMMARY"
for run in $(seq 1 "$RUNS"); do
  for map in $MAPS; do
    for host in native web; do
      printf '\n-- run %s: %s, %s host\n' "$run" "$map" "$host"
      if (cd "$ROOT" && node "$INTEROP/duel.mjs" --app "$APP" --map "$map" --host "$host" --run "$run" \
            --target "$TARGET" --signal "ws://127.0.0.1:$PORT" --port "$VITE_PORT" --repo "$ROOT" --hide 20); then
        echo "PASS run $run $map $host-host" | tee -a "$SUMMARY"
      else
        echo "FAIL run $run $map $host-host" | tee -a "$SUMMARY"
        echo "M6 check failed on run $run ($map, $host host). Artifacts: $LOGS/duel-$map-$host-host-$run" >&2
        exit 1
      fi
    done
  done
done

printf '\nM6 check passed: %s consecutive runs. Summary: %s\n' "$RUNS" "$SUMMARY"
