#!/usr/bin/env bash
# M9post exit check (PLAN.md section 7, M9 post-chain sub-lane; runs on the reference Mac, section 13 Q1).
#   1. renderer unit tests (IronvaleRender, IronvaleMapRender, ShaderTypes)
#   2. Release app build
#   3. web reference captures of Railyard at the 5 poses with every post effect on
#      (?autostart&pose=...&q=high&no=grain: GTAO, SSR, godrays, TRAA, bloom, ACES, vignette)
#   4. native captures with the M9 post chain (--q high --no grain: MetalFX Temporal in place of
#      TRAA) and SSIM against the web; gate: every pose >= 0.93
#   5. a 60 s offscreen flythrough with the High preset (dynamic resolution on) at the display's
#      native resolution; gate: 1% low >= 120 fps
#
# Overrides: SCRATCH (swift scratch path), DERIVED_DATA (xcodebuild derived data), PARITY_OUT
# (capture directory), NATIVE_RES (WxH output for the flythrough; default: the main display's
# native pixel size), SSIM_TARGET, FPS_TARGET, SECONDS_FLY, SKIP_WEB=1 (reuse existing web captures),
# GPU_IDLE_WAIT (seconds to wait for other GPU work to drop below 20% before the flythrough; default 300).
# The GPU utilisation just before the flythrough is printed with the result: other processes on the
# GPU (parallel agents, browsers) lower the frame rate, and the gate is meant for an otherwise idle Mac.
# -ApplePersistenceIgnoreState YES keeps AppKit's "reopen windows?" prompt (after a killed run) from
# blocking a headless launch.
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
TOOLS="$NATIVE/Tools/m3-parity"
OUT="${PARITY_OUT:-$NATIVE/Parity}"
WEB="$OUT/web-post"
NATIVE_OUT="$OUT/native-post"
SSIM_TARGET="${SSIM_TARGET:-0.93}"
FPS_TARGET="${FPS_TARGET:-120}"
SECONDS_FLY="${SECONDS_FLY:-60}"
export DERIVED_DATA="${DERIVED_DATA:-$NATIVE/DerivedData-m9post}"

step() { printf '\n== %s\n' "$*"; }

step "swift test (renderer targets)"
(cd "$NATIVE/IronvaleKit" && swift test --scratch-path "${SCRATCH:-$NATIVE/IronvaleKit/.build-m9post}" \
  --filter 'IronvaleRenderTests|IronvaleMapRenderTests|ShaderTypesTests')

step "xcodegen + xcodebuild (Release)"
APP="$(CONFIGURATION=Release "$NATIVE/ci/build-app.sh" | tail -n 1)"
BIN="$APP/Contents/MacOS/Ironvale"
echo "built $APP"

[[ -f "$NATIVE/MapPackages/railyard/render/scene.json" ]] || {
  echo "FAIL: Railyard render export missing; run node native/Tools/map-export/run.mjs --maps railyard" >&2
  exit 1
}

if [[ "${SKIP_WEB:-0}" == 1 && -f "$WEB/railyard-spawn.png" ]]; then
  step "web captures (reused from $WEB)"
else
  step "web captures (Chrome, WebGPU, q=high, no=grain)"
  node "$TOOLS/capture-web.mjs" --out "$WEB" --no grain
fi

step "native captures (--q high --no grain) + SSIM"
node "$TOOLS/compare.mjs" --app "$APP" --out "$NATIVE_OUT" --web "$WEB" \
  --app-args "--q high --no grain -ApplePersistenceIgnoreState YES"
SSIM_MIN="$(node -e "console.log(require('$NATIVE_OUT/ssim.json').min['web-post'])")"
SSIM_MEAN="$(node -e "console.log(require('$NATIVE_OUT/ssim.json').mean['web-post'])")"

if [[ -z "${NATIVE_RES:-}" ]]; then
  NATIVE_RES="$(system_profiler SPDisplaysDataType 2>/dev/null | awk '/Main Display: Yes/ { print res; exit } /Resolution:/ { res = $2 "x" $4 }')"
fi
[[ "$NATIVE_RES" =~ ^[0-9]+x[0-9]+$ ]] || { echo "FAIL: could not read the display's native resolution; set NATIVE_RES=WxH" >&2; exit 1; }

gpu_busy() { ioreg -r -d 1 -w 0 -c IOAccelerator | sed -n 's/.*"Device Utilization %"=\([0-9]*\).*/\1/p' | head -n 1; }
WAITED=0
until [[ "$(gpu_busy)" -lt 20 || "$WAITED" -ge "${GPU_IDLE_WAIT:-300}" ]]; do sleep 5; WAITED=$((WAITED + 5)); done
GPU_BEFORE="$(gpu_busy)"

step "flythrough ${SECONDS_FLY}s, offscreen, uncapped, High preset, ${NATIVE_RES} output (GPU ${GPU_BEFORE}% busy before)"
"$BIN" --map railyard --flythrough "$SECONDS_FLY" --offscreen --repo "$REPO" --q high --internal "$NATIVE_RES" \
  --frame-log "$NATIVE_OUT/frames.csv" --gpu-log "$NATIVE_OUT/gpu.csv" -ApplePersistenceIgnoreState YES
node "$TOOLS/frame-stats.mjs" "$NATIVE_OUT/frames.csv" "$NATIVE_OUT/gpu.csv" --json "$NATIVE_OUT/frames.json"
LOW="$(node -e "console.log(require('$NATIVE_OUT/frames.json').present.onePercentLowFps)")"

step "result"
FAILED=0
printf 'SSIM vs web (q=high, no=grain, post on): min %.4f, mean %.4f (target >= %s per pose)\n' "$SSIM_MIN" "$SSIM_MEAN" "$SSIM_TARGET"
printf 'Flythrough 1%% low at %s: %.1f fps (target >= %s; GPU %s%% busy with other work before the run)\n' \
  "$NATIVE_RES" "$LOW" "$FPS_TARGET" "$GPU_BEFORE"
node -e "process.exit($SSIM_MIN >= $SSIM_TARGET ? 0 : 1)" || { echo "FAIL: SSIM below target" >&2; FAILED=1; }
node -e "process.exit($LOW >= $FPS_TARGET ? 0 : 1)" || { echo "FAIL: 1% low below target" >&2; FAILED=1; }
if [[ "$FAILED" == 1 ]]; then
  printf '\nM9post check FAILED.\n'
  exit 1
fi
printf '\nM9post check passed.\n'
