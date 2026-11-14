#!/usr/bin/env bash
# M0 exit check (PLAN.md section 7): package builds and tests, app builds, and the app
# presents FRAMES frames through CAMetalDisplayLink and writes a frame-time CSV.
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
FRAMES="${FRAMES:-300}"
TIMEOUT_S="${TIMEOUT_S:-60}"

step() { printf '\n== %s\n' "$*"; }

step "swift build"
(cd "$NATIVE/IronvaleKit" && swift build)

step "swift test"
(cd "$NATIVE/IronvaleKit" && swift test)

step "xcodegen + xcodebuild"
APP="$("$NATIVE/ci/build-app.sh" | tail -n 1)"
echo "built $APP"

step "launch app for $FRAMES frames"
OUT="$(mktemp -d)"
CSV="$OUT/frames.csv"
"$APP/Contents/MacOS/Ironvale" --frames "$FRAMES" --frame-log "$CSV" &
PID=$!
for _ in $(seq 1 $((TIMEOUT_S * 10))); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.1
done
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  echo "FAIL: app did not exit within ${TIMEOUT_S}s" >&2
  exit 1
fi
wait "$PID" || { echo "FAIL: app exited with status $?" >&2; exit 1; }

[[ -f "$CSV" ]] || { echo "FAIL: no frame log at $CSV" >&2; exit 1; }
HEADER="$(head -n 1 "$CSV")"
[[ "$HEADER" == "frame,timestamp_s,dt_ms" ]] || { echo "FAIL: bad CSV header: $HEADER" >&2; exit 1; }
ROWS="$(tail -n +2 "$CSV" | grep -c .)"
[[ "$ROWS" -eq "$FRAMES" ]] || { echo "FAIL: expected $FRAMES rows, got $ROWS" >&2; exit 1; }
awk -F, 'NR > 2 { s += $3; n++; if ($3 > w) w = $3 } END { printf "frames %d, mean dt %.3f ms, worst dt %.3f ms\n", n + 1, s / n, w }' "$CSV"
rm -rf "$OUT"

printf '\nM0 check passed.\n'
