#!/usr/bin/env bash
# M3 exit check (PLAN.md section 7, M3 row; runs on the reference Mac, section 13 Q1).
#   1. renderer unit tests (IronvaleRender, IronvaleMapRender, ShaderTypes)
#   2. Release app build
#   3. web reference captures of Railyard at the 5 poses in native/Parity/railyard-poses.json
#      (?autostart&pose=...&q=high&no=grain,aa, weather and first-person rig removed)
#   4. native captures at the same poses (2560x1600 internal) and SSIM against the web; gate: every pose >= 0.85
#   5. a 60 s flythrough with --frame-log; gate: 1% low >= 120 fps
#
# The flythrough renders offscreen and uncapped by default (--offscreen): macOS pauses a display link
# while its window is covered or on another Space, which turns into multi-second "frames" when the Mac
# is in use. M3_WINDOWED=1 also runs the display-linked, windowed flythrough and reports it.
# M3_DIAGNOSTIC=1 also scores against web captures with every post effect off (no=ssr,ao,godrays,bloom,aa,grain).
# The web build's clock, water and lamp flicker still run during capture: freezing them is W5, pending.
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
PARITY="$NATIVE/Parity"
TOOLS="$NATIVE/Tools/m3-parity"
SSIM_TARGET="${SSIM_TARGET:-0.85}"
FPS_TARGET="${FPS_TARGET:-120}"
SECONDS_FLY="${SECONDS_FLY:-60}"

step() { printf '\n== %s\n' "$*"; }

step "swift test (renderer targets)"
(cd "$NATIVE/IronvaleKit" && swift test --scratch-path "${SCRATCH:-$NATIVE/IronvaleKit/.build-m3}" --filter 'IronvaleRenderTests|IronvaleMapRenderTests|ShaderTypesTests')

step "xcodegen + xcodebuild (Release)"
APP="$(CONFIGURATION=Release "$NATIVE/ci/build-app.sh" | tail -n 1)"
BIN="$APP/Contents/MacOS/Ironvale"
echo "built $APP"

[[ -f "$NATIVE/MapPackages/railyard/render/scene.json" ]] || {
  echo "FAIL: Railyard render export missing; run node native/Tools/map-export/run.mjs --maps railyard" >&2
  exit 1
}
# Surface-program labels and plan numbers (map-export programs.ts) arrived with M3b.
grep -q '"programParams"' "$NATIVE/MapPackages/railyard/render/scene.json" || {
  echo "FAIL: Railyard render export predates surface programs; rerun node native/Tools/map-export/run.mjs --maps railyard" >&2
  exit 1
}

# A killed earlier run (or another agent's) makes AppKit block launch on its "reopen windows?" alert;
# launch without restoring saved state so captures never wait on that modal.
NO_RESTORE=(-ApplePersistenceIgnoreState YES)

step "web captures (Chrome, WebGPU)"
node "$TOOLS/capture-web.mjs" --out "$PARITY/web" --no grain,aa
WEB_DIRS=(--web "$PARITY/web")
if [[ "${M3_DIAGNOSTIC:-0}" == 1 ]]; then
  node "$TOOLS/capture-web.mjs" --out "$PARITY/web-flat" --no ssr,ao,godrays,bloom,aa,grain
  WEB_DIRS+=(--web "$PARITY/web-flat")
fi

step "native captures + SSIM"
node "$TOOLS/compare.mjs" --app "$APP" --app-args "${NO_RESTORE[*]}" --out "$PARITY/native" "${WEB_DIRS[@]}"
SSIM_MIN="$(node -e "console.log(require('$PARITY/native/ssim.json').min.web)")"
SSIM_MEAN="$(node -e "console.log(require('$PARITY/native/ssim.json').mean.web)")"

step "flythrough ${SECONDS_FLY}s, offscreen, uncapped, 2560x1600 internal"
"$BIN" --map railyard --flythrough "$SECONDS_FLY" --offscreen --repo "$REPO" \
  --frame-log "$PARITY/native/frames.csv" --gpu-log "$PARITY/native/gpu.csv" "${NO_RESTORE[@]}"
node "$TOOLS/frame-stats.mjs" "$PARITY/native/frames.csv" "$PARITY/native/gpu.csv" --json "$PARITY/native/frames.json"
LOW="$(node -e "console.log(require('$PARITY/native/frames.json').present.onePercentLowFps)")"

if [[ "${M3_WINDOWED:-0}" == 1 ]]; then
  step "flythrough ${SECONDS_FLY}s, windowed, display-linked"
  "$BIN" --map railyard --flythrough "$SECONDS_FLY" --repo "$REPO" \
    --frame-log "$PARITY/native/frames-window.csv" --gpu-log "$PARITY/native/gpu-window.csv" "${NO_RESTORE[@]}"
  node "$TOOLS/frame-stats.mjs" "$PARITY/native/frames-window.csv" "$PARITY/native/gpu-window.csv"
  STALLS="$(awk -F, 'NR > 2 && $3 > 250' "$PARITY/native/frames-window.csv" | wc -l | tr -d ' ')"
  echo "display-link stalls over 250 ms (window covered or on another Space): $STALLS"
fi

step "result"
FAILED=0
printf 'SSIM vs web (q=high, no=grain,aa): min %.4f, mean %.4f (target >= %s per pose)\n' "$SSIM_MIN" "$SSIM_MEAN" "$SSIM_TARGET"
printf 'Flythrough 1%% low: %.1f fps (target >= %s)\n' "$LOW" "$FPS_TARGET"
node -e "process.exit($SSIM_MIN >= $SSIM_TARGET ? 0 : 1)" || { echo "FAIL: SSIM below target" >&2; FAILED=1; }
node -e "process.exit($LOW >= $FPS_TARGET ? 0 : 1)" || { echo "FAIL: 1% low below target" >&2; FAILED=1; }
if [[ "$FAILED" == 1 ]]; then
  printf '\nM3 check FAILED.\n'
  exit 1
fi
printf '\nM3 check passed.\n'
