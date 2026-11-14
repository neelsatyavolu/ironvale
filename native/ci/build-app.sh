#!/usr/bin/env bash
# Generates IronvaleApp.xcodeproj from project.yml and builds the Ironvale scheme.
# Prints the path of the built Ironvale.app on the last line of stdout.
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$NATIVE/IronvaleApp"
DERIVED="${DERIVED_DATA:-$NATIVE/DerivedData}"
CONFIG="${CONFIGURATION:-Debug}"
# BUILD_NUMBER=n sets CFBundleVersion (CURRENT_PROJECT_VERSION); release builds pass a rising number.
EXTRA=()
[[ -n "${BUILD_NUMBER:-}" ]] && EXTRA+=("CURRENT_PROJECT_VERSION=$BUILD_NUMBER")

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
  ${EXTRA[@]+"${EXTRA[@]}"} \
  build >&2

APP="$DERIVED/Build/Products/$CONFIG/Ironvale.app"
[[ -f "$APP/Contents/Resources/default.metallib" ]] || { echo "default.metallib missing from $APP" >&2; exit 1; }
# The app reads nothing from the repository: its runtime data is staged into the bundle.
for need in Contract/contract.lock Runtime/native/MapPackages Runtime/bundle-manifest.json; do
  [[ -e "$APP/Contents/Resources/$need" ]] || { echo "$need missing from $APP (Stage runtime data phase)" >&2; exit 1; }
done
echo "$APP"
