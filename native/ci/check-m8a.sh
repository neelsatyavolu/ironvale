#!/usr/bin/env bash
# M8a exit check (PLAN.md section 7 and 3.8, audio core):
#   1. the web traces are regenerated from src/audio (Vitest, recording stub AudioContext) and have
#      not drifted from the committed fixtures;
#   2. the 20 scripted scenes' per-voice traces from the native engine match the web's within 1e-6,
#      and the DSP unit tests pass (debug build);
#   3. on an optimized build: no allocation in MixCore.render (malloc_logger hook), and a live
#      AVAudioEngine run at a 128-frame I/O buffer with no device overloads, no render-thread
#      allocations and no dropped commands.
# The live run lasts M8A_SOAK_SECONDS (default 30). The M8a gate is the 10-minute run:
#   M8A_SOAK_SECONDS=600 native/ci/check-m8a.sh
# It plays muted through the built-in output (IRONVALE_AUDIO_AUDIBLE=1 to listen,
# IRONVALE_AUDIO_DEVICE=default for the system output; Bluetooth outputs ignore the 128-frame request).
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
KIT="$NATIVE/IronvaleKit"
DEBUG_SCRATCH="$KIT/.build-m8a"
RELEASE_SCRATCH="$KIT/.build-m8a-rel"
FIXTURES="$NATIVE/Tools/audio-trace/fixtures"
SOAK_SECONDS="${M8A_SOAK_SECONDS:-30}"
REPORT="${TMPDIR:-/tmp}/ironvale-m8a-soak.json"

step() { printf '\n== %s\n' "$*"; }
sums() { (cd "$FIXTURES" && find . -type f -name '*.json' | sort | xargs shasum); }

step "regenerate the web audio traces from src/audio"
BEFORE="$(sums 2>/dev/null || true)"
(cd "$REPO" && npx vitest run --config native/Tools/audio-trace/vitest.config.ts)
AFTER="$(sums)"
if [[ "$BEFORE" != "$AFTER" ]]; then
  echo "FAIL: the web audio traces were out of date with src/ (now regenerated; review and keep the new files)." >&2
  diff <(echo "$BEFORE") <(echo "$AFTER") >&2 || true
  exit 1
fi
SCENES=$(find "$FIXTURES/scenes" -name '*.json' | wc -l | tr -d ' ')
[[ "$SCENES" == "20" ]] || { echo "FAIL: expected 20 scenes, found $SCENES" >&2; exit 1; }

step "swift test IronvaleAudioTests (debug: trace parity, DSP units, offline render)"
LOG_DEBUG="$(mktemp)"
(cd "$KIT" && swift test --scratch-path "$DEBUG_SCRATCH" --filter IronvaleAudioTests 2>&1 | tee "$LOG_DEBUG")
grep -q "Suite TraceParity passed" "$LOG_DEBUG" || { echo "FAIL: TraceParity did not pass" >&2; exit 1; }
grep -c "M8a trace" "$LOG_DEBUG" | grep -qx 20 || { echo "FAIL: not all 20 scenes were compared" >&2; exit 1; }

step "optimized build with tests"
(cd "$KIT" && swift build -c release --build-tests -Xswiftc -enable-testing --scratch-path "$RELEASE_SCRATCH")

step "swift test IronvaleAudioTests (release: no render allocations, live ${SOAK_SECONDS}s at 128 frames)"
LOG_RELEASE="$(mktemp)"
rm -f "$REPORT"
(cd "$KIT" && IRONVALE_AUDIO_SOAK_SECONDS="$SOAK_SECONDS" IRONVALE_AUDIO_SOAK_REPORT="$REPORT" \
  swift test -c release -Xswiftc -enable-testing --skip-build --scratch-path "$RELEASE_SCRATCH" --filter IronvaleAudioTests 2>&1 | tee "$LOG_RELEASE")
for test in "renderDoesNotAllocate()" "liveSoakAt128Frames()" "rendersAFirefightOffline()"; do
  grep -q "Test $test passed" "$LOG_RELEASE" || { echo "FAIL: $test did not run and pass" >&2; exit 1; }
done
grep -q "Test run with .* passed" "$LOG_RELEASE" || { echo "FAIL: release audio tests failed" >&2; exit 1; }

step "live run report"
cat "$REPORT"
printf '\nM8a check passed (live run %ss%s).\n' "$SOAK_SECONDS" "$([[ "$SOAK_SECONDS" -ge 600 ]] && echo ', full 10-minute gate' || echo ', smoke; M8A_SOAK_SECONDS=600 for the gate')"
