#!/usr/bin/env bash
# M11 exit check (PLAN.md section 7, M11 row): Harbor.
#   1. density independence (W1): map-export builds Harbor at detail density 1 and at 0.35 (the Low
#      preset, src/core/settings.ts); collision.bin, boundary.bin, bvh.bin, fixtures/queries.bin and
#      collisionSha256 must be byte-identical between the two
#   2. map-export --check for Harbor: the committed native/MapPackages/harbor matches a fresh export
#   3. duel-rules fixtures --check (includes Harbor's spawns), then swift test for IronvaleNet
#   4. layer 4 duel on Harbor (native/Tools/interop/duel.mjs, the web build in Chrome against the native
#      app): native host and web host, first to M11_TARGET, M11_RUNS consecutive runs, the same
#      assertions as M6 (complementary results, agreeing scores, zero rejected shots or hits)
#   5. co-op scenarios on Harbor (native/Tools/interop/coop.test.ts, `ivpeer --game` against the web's
#      NetSession): co-op with 8 bots in both host roles, host-leaves takeover each way, the duel bot on
#      each side; zero rejections on either side; M11_RUNS consecutive runs
#
# Overrides: SCRATCH (swift scratch path), DERIVED_DATA (app build), M11_APP (skip the build and use
# this Ironvale.app), M11_RUNS (default 5), M11_TARGET (default 10), M11_RELAY_PORT (default 8798),
# M11_VITE_PORT (5311; the relay config only admits 5311), M11_SKIP_DUEL=1, M11_SKIP_COOP=1.
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$NATIVE/.." && pwd)"
INTEROP="$NATIVE/Tools/interop"
SCRATCH="${SCRATCH:-$NATIVE/IronvaleKit/.build-m11}"
# swift runs from native/IronvaleKit: a relative SCRATCH is taken from the caller's directory.
[[ "$SCRATCH" = /* ]] || SCRATCH="$PWD/$SCRATCH"
export DERIVED_DATA="${DERIVED_DATA:-$NATIVE/DerivedData-m11}"
RUNS="${M11_RUNS:-5}"
TARGET="${M11_TARGET:-10}"
PORT="${M11_RELAY_PORT:-8798}"
VITE_PORT="${M11_VITE_PORT:-5311}"
LOGS="$INTEROP/out"
WORK="$SCRATCH/m11-check"
MAP=harbor

step() { printf '\n== %s\n' "$*"; }

PIDS=()
kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}
cleanup() { for pid in "${PIDS[@]:-}"; do [[ -n "$pid" ]] && kill_tree "$pid"; done; return 0; }
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

mkdir -p "$LOGS" "$WORK"

step "dependencies"
[[ -x "$ROOT/signaling/node_modules/.bin/wrangler" ]] || (cd "$ROOT/signaling" && npm ci --no-audit --no-fund)
[[ -d "$INTEROP/node_modules/node-datachannel" ]] || (cd "$INTEROP" && npm ci --no-audit --no-fund)
[[ -d "$ROOT/node_modules/playwright" ]] || { echo "FAIL: playwright missing; run npm ci at the repo root" >&2; exit 1; }

step "Harbor collision at detail density 1 and 0.35"
for density in 1 0.35; do
  rm -rf "$WORK/density-$density"
  (cd "$ROOT" && node native/Tools/map-export/run.mjs --maps "$MAP" --no-render --no-guns --density "$density" --out "$WORK/density-$density")
done
for file in collision.bin boundary.bin bvh.bin fixtures/queries.bin; do
  a="$WORK/density-1/$MAP/$file"
  b="$WORK/density-0.35/$MAP/$file"
  if cmp -s "$a" "$b"; then
    echo "identical: $file ($(wc -c <"$a" | tr -d ' ') bytes, sha256 $(shasum -a 256 "$a" | cut -c1-16))"
  else
    echo "FAIL: $MAP/$file differs between detail density 1 and 0.35" >&2
    exit 1
  fi
done
sha() { node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(`${m.detailDensity} ${m.collisionSha256}`)' "$1"; }
read -r d1 s1 <<<"$(sha "$WORK/density-1/$MAP/meta.json")"
read -r d2 s2 <<<"$(sha "$WORK/density-0.35/$MAP/meta.json")"
[[ "$d1" == 1 && "$d2" == 0.35 ]] || { echo "FAIL: the exports did not run at the asked densities ($d1, $d2)" >&2; exit 1; }
[[ "$s1" == "$s2" ]] || { echo "FAIL: collisionSha256 differs: $s1 at 1, $s2 at 0.35" >&2; exit 1; }
echo "collisionSha256 $s1 at both densities"

step "map-export --check ($MAP)"
(cd "$ROOT" && node native/Tools/map-export/run.mjs --maps "$MAP" --check)

step "duel-rules fixtures --check"
(cd "$ROOT" && NET_FIXTURES_CHECK=1 npx vitest run --config native/Tools/vitest.config.ts native/Tools/interop/duel-fixtures.test.ts)

step "swift test (IronvaleNetTests)"
# Built per target and run with xctest, so another lane's test target cannot fail this check.
(cd "$NATIVE/IronvaleKit" && swift build --scratch-path "$SCRATCH" --target IronvaleNetTests)
TEST_LOG="$SCRATCH/net-tests-m11.log"
xcrun xctest "$(cd "$NATIVE/IronvaleKit" && swift build --scratch-path "$SCRATCH" --show-bin-path)/IronvaleNetTests.xctest" 2>&1 | tee "$TEST_LOG" | grep -E '✘|Test run' || true
grep -q '✔ Test run with .* passed' "$TEST_LOG" || { echo "FAIL: IronvaleNetTests (see $TEST_LOG)" >&2; exit 1; }

step "local relay on $PORT (signaling/src under wrangler dev)"
if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "FAIL: port $PORT is already serving; stop it or set M11_RELAY_PORT" >&2
  exit 1
fi
"$INTEROP/relay.sh" "$PORT" "$INTEROP/wrangler.interop.jsonc" >"$LOGS/relay-m11.log" 2>&1 &
PIDS+=($!)
wait_http "http://127.0.0.1:$PORT/health" "relay" "$LOGS/relay-m11.log"

SUMMARY="$LOGS/m11-summary.txt"
: >"$SUMMARY"

if [[ "${M11_SKIP_DUEL:-0}" != 1 ]]; then
  if [[ -n "${M11_APP:-}" ]]; then
    APP="$M11_APP"
  else
    step "build the app ($DERIVED_DATA)"
    APP="$("$NATIVE/ci/build-app.sh" | tail -1)"
  fi
  [[ -x "$APP/Contents/MacOS/Ironvale" ]] || { echo "FAIL: $APP is not an app bundle" >&2; exit 1; }
  APP="$("$INTEROP/isolate-app.sh" "$APP" "$LOGS/m11-app/IronvaleM6.app")"
  echo "app: $APP"

  step "Vite dev server on $VITE_PORT"
  if curl -sf "http://127.0.0.1:$VITE_PORT/" >/dev/null 2>&1; then
    echo "reusing the server already on $VITE_PORT"
  else
    (cd "$ROOT" && npx vite --port "$VITE_PORT" --strictPort >"$LOGS/vite-m11.log" 2>&1) &
    PIDS+=($!)
    wait_http "http://127.0.0.1:$VITE_PORT/" "Vite" "$LOGS/vite-m11.log"
  fi

  step "layer 4 duel on $MAP: both hosts, $RUNS consecutive runs, first to $TARGET"
  for run in $(seq 1 "$RUNS"); do
    for host in native web; do
      printf '\n-- run %s: %s, %s host\n' "$run" "$MAP" "$host"
      if (cd "$ROOT" && node "$INTEROP/duel.mjs" --app "$APP" --map "$MAP" --host "$host" --run "m11-$run" \
            --target "$TARGET" --signal "ws://127.0.0.1:$PORT" --port "$VITE_PORT" --repo "$ROOT" --hide 20); then
        echo "PASS duel run $run $MAP $host-host" | tee -a "$SUMMARY"
      else
        echo "FAIL duel run $run $MAP $host-host" | tee -a "$SUMMARY"
        echo "M11 check failed: duel run $run ($host host). Artifacts: $LOGS/duel-$MAP-$host-host-m11-$run" >&2
        exit 1
      fi
    done
  done
fi

if [[ "${M11_SKIP_COOP:-0}" != 1 ]]; then
  step "swift build ivpeer"
  (cd "$NATIVE/IronvaleKit" && swift build --scratch-path "$SCRATCH" --product ivpeer)
  IVPEER="$(cd "$NATIVE/IronvaleKit" && swift build --scratch-path "$SCRATCH" --show-bin-path)/ivpeer"
  [[ -x "$IVPEER" ]] || { echo "FAIL: $IVPEER missing" >&2; exit 1; }

  step "co-op and duel-bot scenarios on $MAP, $RUNS consecutive runs"
  for run in $(seq 1 "$RUNS"); do
    printf '\n-- co-op run %s\n' "$run"
    if (cd "$ROOT" && IRONVALE_INTEROP_SIGNAL="ws://127.0.0.1:$PORT" IRONVALE_IVPEER="$IVPEER" IRONVALE_INTEROP_REQUIRED=1 \
          IRONVALE_COOP_MAPS="$MAP" npx vitest run --config native/Tools/vitest.config.ts native/Tools/interop/coop.test.ts); then
      echo "PASS co-op run $run $MAP" | tee -a "$SUMMARY"
    else
      echo "FAIL co-op run $run $MAP" | tee -a "$SUMMARY"
      echo "M11 check failed: co-op run $run. Artifacts: $LOGS/coop/$MAP-*" >&2
      exit 1
    fi
  done
fi

printf '\nM11 check passed: Harbor collision is density-independent; %s consecutive runs. Summary: %s\n' "$RUNS" "$SUMMARY"
