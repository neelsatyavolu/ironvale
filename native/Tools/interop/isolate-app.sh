#!/usr/bin/env bash
# Copies Ironvale.app to DEST as an app of its own (executable, name and bundle id "IronvaleM6"), so
# other agents' `pkill -f Ironvale.app/...`, `quit app "Ironvale"` or hide-by-name never reach a
# layer 4 run, and its saved window state never prompts. Ad-hoc re-signed (hardened runtime is off).
#   isolate-app.sh SOURCE.app DEST.app
set -euo pipefail
SRC="$1"
DEST="$2"
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
ditto "$SRC" "$DEST"
PLIST="$DEST/Contents/Info.plist"
mv "$DEST/Contents/MacOS/Ironvale" "$DEST/Contents/MacOS/IronvaleM6"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable IronvaleM6" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleName IronvaleM6" "$PLIST"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier dev.n3el.ironvale.m6" "$PLIST"
/usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$PLIST" 2>/dev/null || true
codesign --force --sign - "$DEST" >/dev/null 2>&1
echo "$DEST"
