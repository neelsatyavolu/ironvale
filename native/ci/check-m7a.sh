#!/usr/bin/env bash
# M7a exit check (PLAN.md section 7, M7a row; runs on the reference Mac, section 13 Q1).
#   1. characters-export --check: native/Contract/characters.json and the soldier fixtures match what
#      src/characters produces now (constants, pose, IK, gun hold, locomotion, death, reactions, LOD,
#      rig, whole-soldier scenarios on the real soldier.glb)
#   2. asset-bake: soldier.glb and carbine.glb -> IVM + PNG in native/BakedAssets/characters
#   3. Swift tests: IronvaleCharactersTests (every fixture above) and IronvaleAssetsTests (IVM reader)
#   4. Release app build
#   5. offscreen benchmark: 32 animated soldiers, all on screen, 2560x1600 with a 4096 sun shadow map
#      and Railyard's lighting; gate: GPU time of the soldier passes per frame, mean and median both
#      < 2 ms, with all 32 drawn every frame. p95 and p99 are reported: they are what other GPU and CPU
#      load on the Mac moves first (parallel agent builds pushed p95 from 0.5 to 3 ms in testing), so
#      run this on a quiet machine for the tail numbers.
#
# The tests are built and run per target (swift build --target + xctest) so another lane's
# half-finished test target cannot fail this check.
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
OUT="$NATIVE/Parity/m7a"
SCRATCH="${SCRATCH:-$NATIVE/IronvaleKit/.build-m7a}"
GPU_TARGET_MS="${GPU_TARGET_MS:-2}"
SOLDIERS="${SOLDIERS:-32}"
SECONDS_BENCH="${SECONDS_BENCH:-20}"
mkdir -p "$OUT"

step() { printf '\n== %s\n' "$*"; }

step "characters-export --check (src/characters -> native/Contract)"
"$NATIVE/Tools/asset-bake/characters-export.sh" --check

step "asset-bake (soldier.glb, carbine.glb -> IVM)"
node "$NATIVE/Tools/asset-bake/bake.mjs"

step "swift tests (IronvaleCharactersTests, IronvaleAssetsTests)"
BIN="$(cd "$NATIVE/IronvaleKit" && swift build --scratch-path "$SCRATCH" --show-bin-path)"
for target in IronvaleCharactersTests IronvaleAssetsTests; do
  (cd "$NATIVE/IronvaleKit" && swift build --scratch-path "$SCRATCH" --target "$target")
  LOG="$SCRATCH/$target.log"
  xcrun xctest "$BIN/$target.xctest" 2>&1 | tee "$LOG" | grep -E '✘|max difference|Test run' || true
  grep -q '✔ Test run with .* passed' "$LOG" || { echo "FAIL: $target" >&2; exit 1; }
done

step "xcodegen + xcodebuild (Release)"
APP="$(CONFIGURATION=Release "$NATIVE/ci/build-app.sh" | tail -n 1)"
echo "built $APP"

step "soldier benchmark: $SOLDIERS soldiers, ${SECONDS_BENCH}s, offscreen"
"$APP/Contents/MacOS/Ironvale" --soldier-bench "$SECONDS_BENCH" --soldiers "$SOLDIERS" --map railyard --repo "$REPO" \
  --bench-json "$OUT/bench.json" --gpu-log "$OUT/gpu.csv" --capture "$OUT/soldiers.png" \
  -ApplePersistenceIgnoreState YES  # never wait on AppKit's "reopen windows?" alert after a killed run
cat "$OUT/bench.json"

step "result"
node -e "
const r = require('$OUT/bench.json');
const ok = r.gpuMs.mean < $GPU_TARGET_MS && r.gpuMs.p50 < $GPU_TARGET_MS && r.drawnPerFrameMin === r.soldiers && r.soldiers >= $SOLDIERS;
console.log('GPU per frame (soldier passes): mean ' + r.gpuMs.mean.toFixed(3) + ' ms, median ' + r.gpuMs.p50.toFixed(3) + ' ms, p95 ' + r.gpuMs.p95.toFixed(3) + ' ms, p99 ' + r.gpuMs.p99.toFixed(3) + ' ms (target: mean and median < $GPU_TARGET_MS ms)');
console.log('CPU pose + upload per frame: mean ' + r.cpuMs.mean.toFixed(3) + ' ms, p95 ' + r.cpuMs.p95.toFixed(3) + ' ms; poses per frame ' + r.posesPerFrame.toFixed(1));
console.log('Soldiers drawn per frame (min): ' + r.drawnPerFrameMin + ' of ' + r.soldiers + ', ' + r.frames + ' frames');
process.exit(ok ? 0 : 1);
" || { printf '\nM7a check FAILED.\n'; exit 1; }
printf '\nM7a check passed.\n'
