#!/usr/bin/env bash
# Builds a Developer ID signed, notarized and stapled Ironvale.app and zips it (docs/native-port/RELEASE.md).
# Needs, on this Mac: a "Developer ID Application" identity in the keychain and the notarytool keychain
# profile `ironvale-notary`. Nothing secret is read or written here.
# project.yml stays ad-hoc so the check scripts can re-sign their test copies; this script re-signs the
# Release build inside out with the hardened runtime. Signing WebRTC.framework with the same identity
# satisfies library validation, so no entitlement exception is needed.
#   IDENTITY="Developer ID Application: …"   pick one identity when several exist
#   NOTARY_PROFILE=name                      keychain profile (default ironvale-notary)
#   BUILD_NUMBER=n                           CFBundleVersion (default: git commit count)
#   OUT=dir                                  output folder (default native/dist)
#   SKIP_NOTARIZE=1                          sign and verify only
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
OUT="${OUT:-$NATIVE/dist}"
PROFILE="${NOTARY_PROFILE:-ironvale-notary}"
ENTITLEMENTS="$NATIVE/IronvaleApp/Resources/Ironvale.entitlements"

step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

if [[ -z "${IDENTITY:-}" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -n 1)"
fi
[[ -n "$IDENTITY" ]] || fail "no Developer ID Application identity in the keychain"

step "Release build"
export CONFIGURATION=Release
export BUILD_NUMBER="${BUILD_NUMBER:-$(git -C "$REPO" rev-list --count HEAD)}"
export DERIVED_DATA="${DERIVED_DATA:-$NATIVE/DerivedData-release}"
BUILT="$("$NATIVE/ci/build-app.sh" | tail -n 1)"
mkdir -p "$OUT"
APP="$OUT/Ironvale.app"
rm -rf "$APP"
ditto "$BUILT" "$APP"
[[ -z "$(find "$APP" -name '*.debug.dylib' -o -name '__preview.dylib')" ]] || fail "Debug dylibs in a Release build"

step "sign inside out with the hardened runtime"
sign() { codesign --force --timestamp --options runtime --sign "$IDENTITY" "$@"; }
while IFS= read -r -d '' framework; do sign "$framework"; done \
  < <(find "$APP/Contents/Frameworks" -maxdepth 1 -name '*.framework' -print0 2>/dev/null)
while IFS= read -r -d '' dylib; do sign "$dylib"; done \
  < <(find "$APP/Contents" -name '*.dylib' -print0)
sign --entitlements "$ENTITLEMENTS" "$APP"

step "verify signature"
codesign --verify --deep --strict --verbose=2 "$APP"
details="$(codesign -d --verbose=4 "$APP" 2>&1)"
grep -q "Authority=Developer ID Application" <<<"$details" || fail "not signed with Developer ID"
grep -q "flags=.*runtime" <<<"$details" || fail "hardened runtime is off"

step "launch smoke test (hardened runtime loads WebRTC.framework)"
SMOKE="$OUT/smoke-frames.csv"
rm -f "$SMOKE"
timeout 120 "$APP/Contents/MacOS/Ironvale" --frames 120 --frame-log "$SMOKE" >/dev/null || fail "signed app did not run"
[[ "$(wc -l <"$SMOKE")" -gt 100 ]] || fail "signed app rendered too few frames"
rm -f "$SMOKE"

VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist")"
ZIP="$OUT/Ironvale-$VERSION-$BUILD_NUMBER.zip"
if [[ "${SKIP_NOTARIZE:-0}" == 1 ]]; then
  echo "signed (not notarized): $APP"
  exit 0
fi

step "notarize and staple"
SUBMIT="$OUT/notarize-upload.zip"
ditto -c -k --keepParent "$APP" "$SUBMIT"
xcrun notarytool submit "$SUBMIT" --keychain-profile "$PROFILE" --wait --output-format json | tee "$OUT/notarize.json"
rm -f "$SUBMIT"
grep -q '"status" *: *"Accepted"' "$OUT/notarize.json" || fail "notarization not accepted (xcrun notarytool log ID --keychain-profile $PROFILE)"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=4 "$APP" 2>&1 | tee /dev/stderr | grep -q "source=Notarized Developer ID" \
  || fail "Gatekeeper does not accept the app"

step "archive"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
shasum -a 256 "$ZIP"
echo "$ZIP"
