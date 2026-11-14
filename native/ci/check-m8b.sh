#!/usr/bin/env bash
# M8b exit check (PLAN.md section 7 and 3.8, audio rooms and HRTF):
#   1. the web impulse fixtures are regenerated from src/audio/impulse.ts (Vitest) and have not
#      drifted from the committed ones;
#   2. debug build: the native ImpulseGenerator reproduces all 15 impulses (5 presets x 44.1, 48 and
#      96 kHz, both channels) bit for bit (SHA-256 of the float32 bytes), Math.pow / Math.log match
#      V8 bit for bit, the partitioned convolver equals direct convolution, the reverb slots
#      crossfade and reset, HRTF lanes spatialise; the M8a trace parity still passes;
#   3. optimized build: the whole audio engine (main-thread work plus MixCore with both reverb slots
#      and 8 HRTF lanes) stays under 5% of one core over a 120 s scripted 16-bot firefight (thread
#      CPU time), and the M8a guarantees still hold with convolution and lanes running: no
#      allocation in MixCore.render, and a live AVAudioEngine run at a 128-frame I/O buffer with no
#      device overloads, no render-thread allocations and no dropped commands.
# The live run lasts M8B_SOAK_SECONDS (default 30; M8B_SOAK_SECONDS=600 matches the M8a 10-minute gate).
# Honours SCRATCH / RELEASE_SCRATCH (swift --scratch-path) like the other checks.
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
KIT="$NATIVE/IronvaleKit"
DEBUG_SCRATCH="${SCRATCH:-$KIT/.build-m8b}"
RELEASE_SCRATCH="${RELEASE_SCRATCH:-${SCRATCH:+$SCRATCH-rel}}"
RELEASE_SCRATCH="${RELEASE_SCRATCH:-$KIT/.build-m8b-rel}"
FIXTURES="$NATIVE/Tools/audio-trace/fixtures"
SOAK_SECONDS="${M8B_SOAK_SECONDS:-30}"
WORK="$(mktemp -d)"
SOAK_REPORT="$WORK/soak.json"
CPU_REPORT="$WORK/cpu.json"

step() { printf '\n== %s\n' "$*"; }
sums() { (cd "$FIXTURES" && shasum impulses.json jsmath-vectors.bin); }

step "regenerate the web impulse fixtures from src/audio/impulse.ts"
BEFORE="$(sums 2>/dev/null || true)"
(cd "$REPO" && npx vitest run --config native/Tools/audio-trace/vitest.config.ts impulse.gen)
AFTER="$(sums)"
if [[ "$BEFORE" != "$AFTER" ]]; then
  echo "FAIL: the web impulse fixtures were out of date with src/ (now regenerated; review and keep the new files)." >&2
  diff <(echo "$BEFORE") <(echo "$AFTER") >&2 || true
  exit 1
fi

step "swift test IronvaleAudioTests (debug: impulse parity, convolver, crossfade, HRTF lanes, M8a trace parity)"
LOG_DEBUG="$WORK/debug.log"
(cd "$KIT" && swift test --scratch-path "$DEBUG_SCRATCH" --filter IronvaleAudioTests 2>&1 | tee "$LOG_DEBUG")
for suite in ImpulseParity RoomsAndHRTF TraceParity; do
  grep -q "Suite $suite passed" "$LOG_DEBUG" || { echo "FAIL: $suite did not pass" >&2; exit 1; }
done
MATCHED=$(grep -c "^M8b impulse .* matches$" "$LOG_DEBUG" || true)
[[ "$MATCHED" == "30" ]] || { echo "FAIL: $MATCHED of 30 impulse channels matched the web bit for bit" >&2; exit 1; }
for test in "impulsesMatchTheWebBitForBit()" "jsMathMatchesNode()" "convolverMatchesDirectConvolution(_:)" \
            "convolverSlotsResetAndIdle()" "mixCoreReverbTailAndCrossfade()" "hrtfLanesSpatialise()"; do
  grep -q "Test $test.* passed" "$LOG_DEBUG" || { echo "FAIL: $test did not run and pass" >&2; exit 1; }
done

step "optimized build with tests"
(cd "$KIT" && swift build -c release --build-tests -Xswiftc -enable-testing --scratch-path "$RELEASE_SCRATCH")

step "swift test IronvaleAudioTests (release: CPU budget, no render allocations, live ${SOAK_SECONDS}s at 128 frames)"
LOG_RELEASE="$WORK/release.log"
(cd "$KIT" && IRONVALE_AUDIO_SOAK_SECONDS="$SOAK_SECONDS" IRONVALE_AUDIO_SOAK_REPORT="$SOAK_REPORT" IRONVALE_M8B_CPU_REPORT="$CPU_REPORT" \
  swift test -c release -Xswiftc -enable-testing --skip-build --scratch-path "$RELEASE_SCRATCH" --filter IronvaleAudioTests 2>&1 | tee "$LOG_RELEASE")
for test in "firefightUnderFivePercentOfACore()" "roomsAndLanesDoNotAllocate()" "renderDoesNotAllocate()" "liveSoakAt128Frames()"; do
  grep -q "Test $test passed" "$LOG_RELEASE" || { echo "FAIL: $test did not run and pass" >&2; exit 1; }
done
grep -q "Test run with .* passed" "$LOG_RELEASE" || { echo "FAIL: release audio tests failed" >&2; exit 1; }

step "CPU report (120 s 16-bot firefight, 48 kHz, 128-frame renders)"
cat "$CPU_REPORT"
step "live run report"
cat "$SOAK_REPORT"
LANES=$(sed -n 's/.*"maxHrtfLanes" : \([0-9]*\).*/\1/p' "$SOAK_REPORT")
[[ "${LANES:-0}" -ge 1 ]] || { echo "FAIL: the live run never used an HRTF lane" >&2; exit 1; }
printf '\nM8b check passed (live run %ss).\n' "$SOAK_SECONDS"
