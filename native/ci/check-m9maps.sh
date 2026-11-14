#!/usr/bin/env bash
# M9maps exit check (PLAN.md section 7, M9 per-map materials sub-lane; runs on the reference Mac,
# section 13 Q1): Headworks, Harbor and the test range with their surface programs, skies and
# backdrops ported (Railyard is M3b and check-m9post.sh).
#   1. renderer unit tests (IronvaleRender, IronvaleMapRender, ShaderTypes)
#   2. Release app build
#   3. render export of the three maps with their program labels, rows, arguments and textures
#      (map-export run.mjs into a temporary directory; only the git-ignored render/ is installed,
#      so the committed packages are never touched)
#   4. web reference captures at the 5 poses in native/Parity/<map>-poses.json
#      (?autostart&pose=...&q=high&no=grain&freeze: post chain on, film grain off, every visual
#      clock held at 0 by the web's ?freeze switch, src/core/freeze.ts)
#   5. native captures at the same preset and frozen clock (--q high --no grain --freeze) and SSIM
#      against the web; gate: every pose of every map >= 0.93
#   6. informational: GPU time per frame and the 1% low of a 15 s offscreen flythrough per map at
#      the High preset (the route is Railyard's loop, so it samples each map rather than touring it;
#      the fps gate is the serial M9 run on a quiet machine)
#
# Overrides: SCRATCH (swift scratch path), DERIVED_DATA (xcodebuild derived data), PARITY_OUT
# (capture directory, default native/Parity/m9maps), MAPS (default "headworks harbor range"),
# SSIM_TARGET, SKIP_EXPORT=1 (use the installed render exports), SKIP_WEB=1 (reuse web captures),
# SKIP_PERF=1 (no flythroughs), SECONDS_FLY (default 15).
# -ApplePersistenceIgnoreState YES keeps AppKit's "reopen windows?" prompt (after a killed run) from
# blocking a headless launch.
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
TOOLS="$NATIVE/Tools/m3-parity"
OUT="${PARITY_OUT:-$NATIVE/Parity/m9maps}"
MAPS="${MAPS:-headworks harbor range}"
SSIM_TARGET="${SSIM_TARGET:-0.93}"
SECONDS_FLY="${SECONDS_FLY:-15}"
export DERIVED_DATA="${DERIVED_DATA:-$NATIVE/DerivedData-m9maps}"
NO_RESTORE="-ApplePersistenceIgnoreState YES"

step() { printf '\n== %s\n' "$*"; }

step "swift test (renderer targets)"
(cd "$NATIVE/IronvaleKit" && swift test --scratch-path "${SCRATCH:-$NATIVE/IronvaleKit/.build-m9maps}" \
  --filter 'IronvaleRenderTests|IronvaleMapRenderTests|ShaderTypesTests')

step "xcodegen + xcodebuild (Release)"
APP="$(CONFIGURATION=Release "$NATIVE/ci/build-app.sh" | tail -n 1)"
BIN="$APP/Contents/MacOS/Ironvale"
echo "built $APP"

if [[ "${SKIP_EXPORT:-0}" == 1 ]]; then
  step "render export (reusing the installed render/ of: $MAPS)"
else
  step "render export ($MAPS)"
  EXPORT="$(mktemp -d "${TMPDIR:-/tmp}/m9maps-export.XXXXXX")"
  trap 'rm -rf "$EXPORT"' EXIT
  node "$NATIVE/Tools/map-export/run.mjs" --out "$EXPORT" --maps "$(echo $MAPS | tr ' ' ',')" --no-guns
  for map in $MAPS; do
    rm -rf "$NATIVE/MapPackages/$map/render"
    cp -R "$EXPORT/$map/render" "$NATIVE/MapPackages/$map/render"
  done
fi
for map in $MAPS; do
  grep -q '"programRows"' "$NATIVE/MapPackages/$map/render/scene.json" || {
    echo "FAIL: $map render export predates its surface programs; rerun without SKIP_EXPORT" >&2
    exit 1
  }
done

FAILED=0
SUMMARY=""
for map in $MAPS; do
  if [[ "${SKIP_WEB:-0}" == 1 ]] && ls "$OUT/web/$map-"*.png >/dev/null 2>&1; then
    step "$map: web captures (reused from $OUT/web)"
  else
    step "$map: web captures (Chrome, WebGPU, q=high, no=grain, freeze)"
    node "$TOOLS/capture-web.mjs" --map "$map" --out "$OUT/web" --no grain --freeze
  fi
  step "$map: native captures (--q high --no grain --freeze) + SSIM"
  node "$TOOLS/compare.mjs" --map "$map" --app "$APP" --out "$OUT/native-$map" --web "$OUT/web" \
    --app-args "--q high --no grain --freeze $NO_RESTORE"
  MIN="$(node -e "console.log(require('$OUT/native-$map/ssim.json').min.web)")"
  MEAN="$(node -e "console.log(require('$OUT/native-$map/ssim.json').mean.web)")"
  LINE="$(printf '%-10s SSIM min %.4f, mean %.4f' "$map" "$MIN" "$MEAN")"
  node -e "process.exit($MIN >= $SSIM_TARGET ? 0 : 1)" || { LINE="$LINE  FAIL"; FAILED=1; }

  if [[ "${SKIP_PERF:-0}" != 1 ]]; then
    step "$map: flythrough ${SECONDS_FLY}s, offscreen, High preset (informational)"
    "$BIN" --map "$map" --flythrough "$SECONDS_FLY" --offscreen --repo "$REPO" --q high \
      --frame-log "$OUT/native-$map/frames.csv" --gpu-log "$OUT/native-$map/gpu.csv" $NO_RESTORE
    node "$TOOLS/frame-stats.mjs" "$OUT/native-$map/frames.csv" "$OUT/native-$map/gpu.csv" --json "$OUT/native-$map/frames.json"
    PERF="$(node -e "const f=require('$OUT/native-$map/frames.json');
      console.log('1% low ' + f.present.onePercentLowFps.toFixed(1) + ' fps, GPU ' + f.gpu.meanMs.toFixed(2) + ' ms/frame mean, ' + f.gpu.p99Ms.toFixed(2) + ' ms p99')")"
    LINE="$LINE; $PERF"
  fi
  SUMMARY="$SUMMARY$LINE"$'\n'
done

step "result"
printf 'SSIM vs web (q=high, no=grain, freeze; target >= %s per pose):\n%s' "$SSIM_TARGET" "$SUMMARY"
for map in $MAPS; do
  node -e "const r=require('$OUT/native-$map/ssim.json').poses; for (const [p,v] of Object.entries(r)) console.log('  $map', p.padEnd(11), v.web.toFixed(4))"
done
if [[ "$FAILED" == 1 ]]; then
  printf '\nM9maps check FAILED.\n'
  exit 1
fi
printf '\nM9maps check passed.\n'
