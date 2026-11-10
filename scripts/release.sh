#!/usr/bin/env bash
# Builds, signs, notarizes and publishes the Mac app as GitHub release v<version>.
#
#   1. Bump "version" in package.json and commit.
#   2. ./scripts/release.sh
#
# Needs the 1Password CLI signed in (proton account), the GitHub CLI, and the
# items "Apple Developer ID Certificate", "Xanom Apple Dev Creds" and
# "Ironvale Tauri Updater Key" in the Private vault.
# The site reads the newest release from GitHub, so nothing else needs deploying.
set -euo pipefail
cd "$(dirname "$0")/.."

export OP_ACCOUNT="${OP_ACCOUNT:-E3OXZANXQRDOBNXQMPXZ6YBHTY}"
export AGMUX_APPLE_SIGNING_VAULT="${AGMUX_APPLE_SIGNING_VAULT:-Private}"
export AGMUX_APPLE_NOTARY_VAULT="${AGMUX_APPLE_NOTARY_VAULT:-Private}"
REPO="neelsatyavolu/ironvale"
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
BUNDLE="src-tauri/target/universal-apple-darwin/release/bundle"

if [ -n "$(git status --porcelain)" ]; then
  echo "error: commit or stash your changes first" >&2
  exit 1
fi
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "error: release $TAG already exists; bump the version in package.json" >&2
  exit 1
fi

# shellcheck disable=SC1091
source scripts/load-apple-creds.sh
cleanup() { rm -rf "${AGMUX_APPLE_CREDS_DIR:-}"; }
trap cleanup EXIT
if [ -z "${APPLE_API_KEY:-}" ]; then
  echo "error: notarization credentials are missing" >&2
  exit 1
fi
TAURI_SIGNING_PRIVATE_KEY="$(op read 'op://Private/Ironvale Tauri Updater Key/ironvale.key')"
export TAURI_SIGNING_PRIVATE_KEY
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

npm run assets
rm -rf "$BUNDLE"
# Six cargo jobs at low priority: this laptop overheats on full-core builds.
CARGO_BUILD_JOBS=6 npm run app:build

APP="$BUNDLE/macos/Ironvale.app"
ARCHIVE="$BUNDLE/macos/Ironvale.app.tar.gz"
DMG="$(ls "$BUNDLE"/dmg/*.dmg | head -1)"
spctl -a -vv -t exec "$APP"
xcrun stapler validate "$APP"

# Tauri notarizes the app; the disk image needs its own ticket.
xcrun notarytool submit "$DMG" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "$DMG"

OUT="$(mktemp -d)"
cp "$DMG" "$OUT/Ironvale.dmg"
cp "$ARCHIVE" "$OUT/Ironvale.app.tar.gz"
SIGNATURE="$(cat "$ARCHIVE.sig")"
URL="https://github.com/$REPO/releases/download/$TAG/Ironvale.app.tar.gz"
node -e '
  const [version, signature, url] = process.argv.slice(1);
  const entry = { signature, url };
  process.stdout.write(JSON.stringify({
    version,
    notes: "See https://github.com/neelsatyavolu/ironvale/releases/tag/v" + version,
    pub_date: new Date().toISOString(),
    platforms: { "darwin-aarch64": entry, "darwin-x86_64": entry },
  }, null, 2));
' "$VERSION" "$SIGNATURE" "$URL" > "$OUT/latest.json"

git tag "$TAG"
git push origin "$TAG"
gh release create "$TAG" --repo "$REPO" --title "Ironvale $VERSION" --generate-notes \
  "$OUT/Ironvale.dmg" "$OUT/Ironvale.app.tar.gz" "$OUT/latest.json"
rm -rf "$OUT"
echo "Published https://github.com/$REPO/releases/tag/$TAG"
