#!/usr/bin/env bash
# M9post exit check (PLAN.md section 7, M9 post-chain sub-lane; runs on the reference Mac, section 13 Q1).
#   1. renderer unit tests (IronvaleRender, IronvaleMapRender, ShaderTypes)
#   2. Release app build
#   3. web reference captures of Railyard at the 5 poses with every post effect on
#      (?autostart&pose=...&q=high&no=grain&freeze: GTAO, SSR, godrays, TRAA, bloom, ACES, vignette;
#      ?freeze holds shader clocks, FX and map animations still so the captures are deterministic)
#   4. native captures with the M9 post chain (--q high --no grain --freeze: MetalFX Temporal in place
#      of TRAA) and SSIM against the web; gate: every pose >= 0.93
#   5. a 60 s offscreen flythrough with the High preset at the display's native resolution, with the
#      player's Target FPS set to 120 and dynamic resolution on (--target-fps 120 --dynamic-resolution
#      on; --q alone turns dynamic resolution off, as the web's ?q= does); gate: 1% low >= 120 fps.
#      GPU milliseconds per frame (median, p99) are printed with it: on a GPU shared with other work
#      they are the number to compare, the frame rate is pessimistic.
#   6. a 15 s profiled flythrough at the fixed High render scale (IV_POST_PROFILE=1, dynamic resolution
#      off): per-pass GPU milliseconds of the frame (sun shadow, scene, every post pass; mean, median,
#      p10, p99), printed, not gated.
#
# Overrides: SCRATCH (swift scratch path), DERIVED_DATA (xcodebuild derived data), PARITY_OUT
# (capture directory), NATIVE_RES (WxH output for the flythrough; default: the main display's
# native pixel size), SSIM_TARGET, FPS_TARGET, SECONDS_FLY, SKIP_WEB=1 (reuse existing web captures),
# GPU_IDLE_WAIT (seconds to wait for other GPU work to drop below 20% before the flythrough; default 300),
# SKIP_PROFILE=1 (no step 6).
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
  step "web captures (Chrome, WebGPU, q=high, no=grain, freeze)"
  node "$TOOLS/capture-web.mjs" --out "$WEB" --no grain --freeze
fi

step "native captures (--q high --no grain --freeze) + SSIM"
node "$TOOLS/compare.mjs" --app "$APP" --out "$NATIVE_OUT" --web "$WEB" \
  --app-args "--q high --no grain --freeze -ApplePersistenceIgnoreState YES"
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

step "flythrough ${SECONDS_FLY}s, offscreen, uncapped, High preset, target 120 fps, dynamic resolution, ${NATIVE_RES} output (GPU ${GPU_BEFORE}% busy before)"
"$BIN" --map railyard --flythrough "$SECONDS_FLY" --offscreen --repo "$REPO" --q high --target-fps 120 --dynamic-resolution on \
  --internal "$NATIVE_RES" --frame-log "$NATIVE_OUT/frames.csv" --gpu-log "$NATIVE_OUT/gpu.csv" -ApplePersistenceIgnoreState YES
node "$TOOLS/frame-stats.mjs" "$NATIVE_OUT/frames.csv" "$NATIVE_OUT/gpu.csv" --json "$NATIVE_OUT/frames.json"
LOW="$(node -e "console.log(require('$NATIVE_OUT/frames.json').present.onePercentLowFps)")"
gpu_ms() {  # median and p99 GPU ms per frame of a --gpu-log CSV
  node -e 'const v=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").slice(1).map(r=>+r.split(",")[1]).filter(x=>x>0).sort((a,b)=>a-b);
    const q=p=>v[Math.floor(p*(v.length-1))];console.log(`median ${q(0.5).toFixed(2)} ms, p99 ${q(0.99).toFixed(2)} ms`)' "$1"
}
GPU_MS="$(gpu_ms "$NATIVE_OUT/gpu.csv")"
GPU_AFTER="$(gpu_busy)"

PROFILE=""
if [[ "${SKIP_PROFILE:-0}" != 1 ]]; then
  step "profiled flythrough 15s, fixed High render scale, ${NATIVE_RES} output"
  IV_POST_PROFILE=1 "$BIN" --map railyard --flythrough 15 --offscreen --repo "$REPO" --q high --internal "$NATIVE_RES" \
    --gpu-log "$NATIVE_OUT/gpu-fixed.csv" -ApplePersistenceIgnoreState YES 2> "$NATIVE_OUT/profile.log"
  # The last report covers the whole run.
  awk '/^pass profile/ { block = "" } { block = block $0 "\n" } END { printf "%s", block }' "$NATIVE_OUT/profile.log"
  PROFILE="$(gpu_ms "$NATIVE_OUT/gpu-fixed.csv")"
fi

step "result"
FAILED=0
printf 'SSIM vs web (q=high, no=grain, post on): min %.4f, mean %.4f (target >= %s per pose)\n' "$SSIM_MIN" "$SSIM_MEAN" "$SSIM_TARGET"
printf 'Flythrough 1%% low at %s: %.1f fps (target >= %s; GPU %s%% busy before the run, %s%% after)\n' \
  "$NATIVE_RES" "$LOW" "$FPS_TARGET" "$GPU_BEFORE" "$GPU_AFTER"
printf 'GPU time per frame, dynamic resolution: %s\n' "$GPU_MS"
[[ -n "$PROFILE" ]] && printf 'GPU time per frame, fixed High render scale (profiled run): %s\n' "$PROFILE"
node -e "process.exit($SSIM_MIN >= $SSIM_TARGET ? 0 : 1)" || { echo "FAIL: SSIM below target" >&2; FAILED=1; }
node -e "process.exit($LOW >= $FPS_TARGET ? 0 : 1)" || { echo "FAIL: 1% low below target" >&2; FAILED=1; }
if [[ "$FAILED" == 1 ]]; then
  printf '\nM9post check FAILED.\n'
  exit 1
fi
printf '\nM9post check passed.\n'
