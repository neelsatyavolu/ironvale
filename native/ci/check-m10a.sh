#!/usr/bin/env bash
# M10a exit check (PLAN.md section 7, M10 SwiftUI screens): the web UI data is regenerated from src/ and has
# not drifted, IronvaleUI builds, and its tests pass (settings JSON round-trips against the web fixtures,
# ported logic matches the web's answers, every screen renders at three window sizes).
# IV_UI_SNAPSHOTS=/some/dir also writes the rendered screens as PNGs for review.
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
SCRATCH="$NATIVE/IronvaleKit/.build-m10"
GENERATED=(
  "$NATIVE/IronvaleKit/Sources/IronvaleUI/Generated/WebUIData.swift"
  "$NATIVE/Tools/ui-fixtures/fixtures/web-ui-fixtures.json"
)

step() { printf '\n== %s\n' "$*"; }
sums() { for f in "${GENERATED[@]}"; do [[ -f "$f" ]] && shasum "$f" || echo "missing $f"; done; }

step "regenerate web UI data and fixtures from src/"
BEFORE="$(sums)"
(cd "$REPO" && npx vitest run --config native/Tools/ui-fixtures/vitest.config.ts)
AFTER="$(sums)"
if [[ "$BEFORE" != "$AFTER" ]]; then
  echo "FAIL: generated UI data was out of date with src/ (now regenerated; review and keep the new files)." >&2
  diff <(echo "$BEFORE") <(echo "$AFTER") >&2 || true
  exit 1
fi

step "swift build"
(cd "$NATIVE/IronvaleKit" && swift build --scratch-path "$SCRATCH")

step "swift test (IronvaleUITests)"
(cd "$NATIVE/IronvaleKit" && swift test --scratch-path "$SCRATCH" --filter IronvaleUITests)

printf '\nM10a check passed.\n'
