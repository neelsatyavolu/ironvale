#!/usr/bin/env bash
# M9 view-model exit check (PLAN.md section 7, M9 view-model sub-lane; runs on the reference Mac, section 13 Q1).
#   1. the rig fixtures and view-model tables are current: native/Tools/viewmodel-export re-runs the web's
#      src/weapons/view rig, gun view, parts animator and arms IK under Vitest and must reproduce
#      native/Contract/viewmodel.json and fixtures/viewmodel-poses.json byte for byte
#   2. bake the gun-export GLBs and arms.glb into native/BakedAssets/viewmodel (IVM + PNG)
#   3. swift test IronvaleViewModelTests: the native rig replays every fixture frame (idle, ADS, fire,
#      reload, sprint, move, per weapon) and matches holder, parts, hand targets, muzzle, ejection port and
#      every arm bone within 1e-4
#   4. Release app build
#   5. frozen captures of every weapon at the hip and aimed, web (?freeze, debugInput) against native
#      (--freeze --vm-weapon --vm-aim) at Railyard's spawn pose, q=high, no=grain; gate: every frame SSIM >= 0.93
#      (the SSIM of the lower-right quarter, where the gun and arms are, is printed with it)
#   6. GPU cost at 3024x1964, High: per weapon, frame pairs with and without the view model, alternating;
#      gate: the median paired difference <= 0.5 ms for every weapon (GPU medians of both are printed;
#      on a GPU shared with other work the frame times rise, the paired difference is what to compare)
#
# Overrides: SCRATCH (swift scratch path), DERIVED_DATA (xcodebuild derived data), PARITY_OUT (capture
# directory), SSIM_TARGET, GPU_TARGET_MS, BENCH_FRAMES, BENCH_RES (WxH), SKIP_WEB=1 (reuse web captures).
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
OUT="${PARITY_OUT:-$NATIVE/Parity/m9vm}"
SSIM_TARGET="${SSIM_TARGET:-0.93}"
GPU_TARGET_MS="${GPU_TARGET_MS:-0.5}"
BENCH_FRAMES="${BENCH_FRAMES:-300}"
BENCH_RES="${BENCH_RES:-3024x1964}"
export DERIVED_DATA="${DERIVED_DATA:-$NATIVE/DerivedData-m9vm}"

step() { printf '\n== %s\n' "$*"; }

[[ -f "$NATIVE/MapPackages/guns/m4a1.glb" ]] || {
  echo "FAIL: gun-export GLBs missing; run node native/Tools/map-export/run.mjs (guns)" >&2
  exit 1
}

step "viewmodel-export --check (rig fixtures and tables from src/weapons)"
"$NATIVE/Tools/viewmodel-export/viewmodel-export.sh" --check

step "bake guns and arms (native/BakedAssets/viewmodel)"
node "$NATIVE/Tools/viewmodel-export/bake.mjs"

step "swift test IronvaleViewModelTests (rig poses within 1e-4)"
(cd "$NATIVE/IronvaleKit" && swift test --scratch-path "${SCRATCH:-$NATIVE/IronvaleKit/.build-m9vm}" --filter IronvaleViewModelTests)

step "xcodegen + xcodebuild (Release)"
APP="$(CONFIGURATION=Release "$NATIVE/ci/build-app.sh" | tail -n 1)"
BIN="$APP/Contents/MacOS/Ironvale"
echo "built $APP"

step "captures: web (?freeze) and native (--freeze), every weapon at the hip and aimed, + SSIM"
CAPTURE_ARGS=(--app "$APP" --out "$OUT")
[[ "${SKIP_WEB:-0}" == 1 && -f "$OUT/web/m4a1-hip.png" ]] && CAPTURE_ARGS+=(--skip-web)
node "$NATIVE/Tools/viewmodel-export/capture-vm.mjs" "${CAPTURE_ARGS[@]}"
SSIM_MIN="$(node -e "console.log(require('$OUT/ssim.json').min)")"
SSIM_MEAN="$(node -e "console.log(require('$OUT/ssim.json').mean)")"

gpu_busy() { ioreg -r -d 1 -w 0 -c IOAccelerator | sed -n 's/.*"Device Utilization %"=\([0-9]*\).*/\1/p' | head -n 1; }
step "GPU cost at $BENCH_RES, High (GPU ${GPU_BUSY:-$(gpu_busy)}% busy before)"
WORST=0
for weapon in $(node -e "console.log(Object.keys(require('$NATIVE/Contract/viewmodel.json').weapons).join(' '))"); do
  "$BIN" --map railyard --pose -3,0,45.5,0,0 --repo "$REPO" --q high --no grain --freeze --internal "$BENCH_RES" \
    --vm-weapon "$weapon" --vm-bench "$BENCH_FRAMES" --bench-json "$OUT/bench-$weapon.json" -ApplePersistenceIgnoreState YES 2>/dev/null \
    | grep "view model bench"
  WORST="$(node -e "console.log(Math.max($WORST, require('$OUT/bench-$weapon.json').pairDifferenceMedianMs))")"
done

step "result"
FAILED=0
printf 'Rig fixtures: matched within 1e-4 (swift test above)\n'
printf 'SSIM vs web (q=high, no=grain, freeze; 6 weapons x hip/ADS): min %.4f, mean %.4f (target >= %s)\n' "$SSIM_MIN" "$SSIM_MEAN" "$SSIM_TARGET"
printf 'View model GPU cost at %s, High: worst median paired difference %.3f ms (target <= %s ms)\n' "$BENCH_RES" "$WORST" "$GPU_TARGET_MS"
node -e "process.exit($SSIM_MIN >= $SSIM_TARGET ? 0 : 1)" || { echo "FAIL: SSIM below target" >&2; FAILED=1; }
node -e "process.exit($WORST <= $GPU_TARGET_MS ? 0 : 1)" || { echo "FAIL: view model GPU cost above target" >&2; FAILED=1; }
if [[ "$FAILED" == 1 ]]; then
  printf '\nM9vm check FAILED.\n'
  exit 1
fi
printf '\nM9vm check passed.\n'
