#!/usr/bin/env bash
# Generates IronvaleApp.xcodeproj from project.yml and builds the Ironvale scheme.
# Prints the path of the built Ironvale.app on the last line of stdout.
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$NATIVE/IronvaleApp"
DERIVED="${DERIVED_DATA:-$NATIVE/DerivedData}"
CONFIG="${CONFIGURATION:-Debug}"

XCODEGEN="$(command -v xcodegen || echo /opt/homebrew/bin/xcodegen)"
[[ -x "$XCODEGEN" ]] || { echo "xcodegen not found (brew install xcodegen)" >&2; exit 1; }

# Serialize generate+build: parallel agents share one project.yml/.xcodeproj.
LOCK="$NATIVE/.build-app.lock"
until mkdir "$LOCK" 2>/dev/null; do sleep 2; done
trap 'rmdir "$LOCK"' EXIT

(cd "$APP_DIR" && "$XCODEGEN" generate --quiet) >&2
xcodebuild \
  -project "$APP_DIR/IronvaleApp.xcodeproj" \
  -scheme Ironvale \
  -configuration "$CONFIG" \
  -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath "$DERIVED" \
  build >&2

APP="$DERIVED/Build/Products/$CONFIG/Ironvale.app"
[[ -f "$APP/Contents/Resources/default.metallib" ]] || { echo "default.metallib missing from $APP" >&2; exit 1; }
echo "$APP"
