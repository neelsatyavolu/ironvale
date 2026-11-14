#!/usr/bin/env bash
# M9 FX exit check (PLAN.md section 7, M9 effects and weather sub-lane; runs on the reference Mac, section 13 Q1).
#   1. fixtures: native/Tools/fx-fixtures/run.sh --check regenerates native/Contract/fx from src/fx (the real
#      modules run headless with Math.random replaced by mulberry32) and must equal what is committed
#   2. swift test IronvaleFXTests: spawn, lifetime and pooling of every module against those fixtures
#      (both particle pools, rings, tracers, decals, muzzle flashes and their lights, casings, blast
#      shake, weather state, roof mask, random draw counts), pools, tracer math, casing physics
#   3. no per-frame heap allocation in the effects update: a 16-bot firefight with rain, 2400 frames under
#      libmalloc's logger, in a Release build (swift test -c release); gate: 0 allocations
#   4. Release app build; the effect atlases baked from the web's Canvas2D code in Chrome
#   5. per map, at its 5 parity poses (native/Parity/<map>-poses.json), web vs native captures with the
#      effects on (?freeze / --freeze, q=high, no=grain):
#        weather (the map's rain, mist or motes): gate SSIM >= 0.93 per pose
#        scripted FX scene (native/Tools/fx-parity/scene.json: bot shots, impacts, a grenade), resolved and
#        emitted by the web capture with a seeded effect random stream and replayed natively with the same
#        seed (the native capture fails if its random draws differ): gate SSIM >= 0.90 per pose
#   6. GPU cost: a scripted 16-bot firefight (IronvaleFX Firefight) on Railyard (rain on) at 3024x1964, High,
#      frames alternating with and without the effects drawn; gate: paired difference median <= 1.0 ms.
#      Then a profiled run (IV_POST_PROFILE=1) prints per-pass GPU ms with the effects on.
#
# Overrides: SCRATCH (swift scratch path), DERIVED_DATA, PARITY_OUT, MAPS, SSIM_WEATHER, SSIM_SCENE,
# FX_BUDGET_MS, BENCH_RES (WxH, default 3024x1964), BENCH_FRAMES, SKIP_WEB=1 (reuse web captures).
# -ApplePersistenceIgnoreState YES keeps AppKit's "reopen windows?" prompt from blocking a headless launch.
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
TOOLS="$NATIVE/Tools/fx-parity"
OUT="${PARITY_OUT:-$NATIVE/Parity/m9fx}"
MAPS="${MAPS:-railyard headworks harbor range}"
SSIM_WEATHER="${SSIM_WEATHER:-0.93}"
SSIM_SCENE="${SSIM_SCENE:-0.90}"
FX_BUDGET_MS="${FX_BUDGET_MS:-1.0}"
BENCH_RES="${BENCH_RES:-3024x1964}"
BENCH_FRAMES="${BENCH_FRAMES:-600}"
SCRATCH="${SCRATCH:-$NATIVE/IronvaleKit/.build-m9fx}"
export DERIVED_DATA="${DERIVED_DATA:-$NATIVE/DerivedData-m9fx}"
NO_RESTORE="-ApplePersistenceIgnoreState YES"
APP_ARGS="--q high --no grain --freeze $NO_RESTORE"

step() { printf '\n== %s\n' "$*"; }
FAILED=0
SUMMARY=""
note() { SUMMARY="$SUMMARY$1"$'\n'; }

step "fixtures: native/Contract/fx regenerated from src/fx must match"
"$NATIVE/Tools/fx-fixtures/run.sh" --check

step "swift test IronvaleFXTests (fixtures, Debug)"
(cd "$NATIVE/IronvaleKit" && swift test --scratch-path "$SCRATCH" --filter 'IronvaleFXTests')

step "allocation test (Release): no heap allocation in the effects update"
(cd "$NATIVE/IronvaleKit" && swift test -c release -Xswiftc -enable-testing --scratch-path "$SCRATCH" \
  --filter 'IronvaleFXTests.firefightUpdateDoesNotAllocate')

step "effect atlases (Chrome)"
node "$TOOLS/bake-atlases.mjs"

step "xcodegen + xcodebuild (Release)"
APP="$(CONFIGURATION=Release "$NATIVE/ci/build-app.sh" | tail -n 1)"
BIN="$APP/Contents/MacOS/Ironvale"
echo "built $APP"

min_of() { node -e "console.log(require('$1').min)"; }
for map in $MAPS; do
  for kind in weather scene; do
    WEB="$OUT/web-$kind"
    flag=""; target="$SSIM_WEATHER"
    if [[ "$kind" == scene ]]; then flag="--scene"; target="$SSIM_SCENE"; fi
    if [[ "${SKIP_WEB:-0}" == 1 ]] && ls "$WEB/$map-"*.png >/dev/null 2>&1; then
      step "$map $kind: web captures (reused from $WEB)"
    else
      step "$map $kind: web captures (Chrome, WebGPU, q=high, no=grain, freeze)"
      node "$TOOLS/capture-web.mjs" --map "$map" --out "$WEB" $flag
    fi
    step "$map $kind: native captures + SSIM"
    node "$TOOLS/compare.mjs" --app "$APP" --map "$map" --web "$WEB" --out "$OUT/native-$kind" $flag --app-args "$APP_ARGS"
    MIN="$(min_of "$OUT/native-$kind/$map-ssim.json")"
    LINE="$(printf '%-10s %-8s SSIM min %.4f (target >= %s)' "$map" "$kind" "$MIN" "$target")"
    node -e "process.exit($MIN >= $target ? 0 : 1)" || { LINE="$LINE  FAIL"; FAILED=1; }
    note "$LINE"
  done
done

gpu_busy() { ioreg -r -d 1 -w 0 -c IOAccelerator | sed -n 's/.*"Device Utilization %"=\([0-9]*\).*/\1/p' | head -n 1; }
step "GPU cost: 16-bot firefight on Railyard at $BENCH_RES, High (GPU $(gpu_busy)% busy before)"
POSE="$(node -e "console.log(require('$NATIVE/Parity/railyard-poses.json').poses.spawn.join(','))")"
"$BIN" --map railyard --pose "$POSE" --repo "$REPO" --q high --internal "$BENCH_RES" --fx-bench "$BENCH_FRAMES" \
  --bench-json "$OUT/bench.json" $NO_RESTORE
COST="$(node -e "console.log(require('$OUT/bench.json').pairDifferenceMedianMs)")"
LINE="$(node -e "const b=require('$OUT/bench.json');console.log(\`fx GPU cost at \${b.width}x\${b.height}: paired difference median \${b.pairDifferenceMedianMs.toFixed(3)} ms, mean \${b.pairDifferenceMeanMs.toFixed(3)} ms (frame GPU median with \${b.withMedianMs.toFixed(2)} ms, without \${b.withoutMedianMs.toFixed(2)} ms)\`)") (target <= $FX_BUDGET_MS ms; GPU $(gpu_busy)% busy after)"
node -e "process.exit($COST <= $FX_BUDGET_MS ? 0 : 1)" || { LINE="$LINE  FAIL"; FAILED=1; }
note "$LINE"

step "per-pass GPU ms during the firefight (IV_POST_PROFILE=1, informational; frames alternate with and without effects, the scene pass holds them)"
IV_POST_PROFILE=1 "$BIN" --map railyard --pose "$POSE" --repo "$REPO" --q high --internal "$BENCH_RES" --fx-bench 240 \
  $NO_RESTORE 2> "$OUT/profile.log" >/dev/null || true
awk '/^pass profile/ { block = "" } { block = block $0 "\n" } END { printf "%s", block }' "$OUT/profile.log"

step "result"
printf '%s' "$SUMMARY"
if [[ "$FAILED" == 1 ]]; then
  printf '\nM9fx check FAILED.\n'
  exit 1
fi
printf '\nM9fx check passed.\n'
