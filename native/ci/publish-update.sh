#!/usr/bin/env bash
# Publishes a notarized build from native/ci/release.sh as a Sparkle update (docs/native-port/RELEASE.md):
#   1. signs the zip with the Ironvale Sparkle EdDSA key, read from 1Password and passed on stdin (never written);
#   2. uploads the zip to a GitHub release tagged native-v<version>-<build>;
#   3. adds an <item> to public/native/appcast.xml. Commit that file on main and the web deploy serves it at
#      https://ironvale.n3el.dev/native/appcast.xml (SUFeedURL).
# Usage: native/ci/publish-update.sh native/dist/Ironvale-<version>-<build>.zip
#   OP_ACCOUNT=id          1Password account (default: the Proton account)
#   APPCAST=path           appcast file to update (default public/native/appcast.xml in this checkout)
#   NOTES="text"           release notes (plain text) for the update window and the GitHub release
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
ZIP="${1:?usage: publish-update.sh path/to/Ironvale-VERSION-BUILD.zip}"
ACCOUNT="${OP_ACCOUNT:-E3OXZANXQRDOBNXQMPXZ6YBHTY}"
KEY_REF="op://Private/Ironvale Sparkle Update Key/password"
APPCAST="${APPCAST:-$REPO/public/native/appcast.xml}"
SPARKLE_VERSION=2.10.0
TOOLS="$NATIVE/.sparkle-tools/$SPARKLE_VERSION"
GH_REPO="neelsatyavolu/ironvale"

fail() { echo "FAIL: $*" >&2; exit 1; }
[[ -f "$ZIP" ]] || fail "no such file: $ZIP"
[[ -f "$APPCAST" ]] || fail "no appcast at $APPCAST"

name="$(basename "$ZIP" .zip)"                      # Ironvale-0.1.0-38
version="$(cut -d- -f2 <<<"$name")"
build="$(cut -d- -f3 <<<"$name")"
[[ "$version" =~ ^[0-9]+(\.[0-9]+)*$ && "$build" =~ ^[0-9]+$ ]] || fail "expected Ironvale-VERSION-BUILD.zip, got $name.zip"
grep -q "<sparkle:version>$build</sparkle:version>" "$APPCAST" && fail "build $build is already in the appcast"

# The archive must hold a stapled, Developer ID app with the same version.
check="$(mktemp -d)"
trap 'rm -rf "$check"' EXIT
ditto -x -k "$ZIP" "$check"
app="$check/Ironvale.app"
xcrun stapler validate "$app" >/dev/null || fail "the app in $ZIP is not stapled"
[[ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleVersion' "$app/Contents/Info.plist")" == "$build" ]] || fail "CFBundleVersion is not $build"
minimum="$(/usr/libexec/PlistBuddy -c 'Print LSMinimumSystemVersion' "$app/Contents/Info.plist" 2>/dev/null || echo 26.0)"

if [[ ! -x "$TOOLS/bin/sign_update" ]]; then
  mkdir -p "$TOOLS"
  gh release download "$SPARKLE_VERSION" -R sparkle-project/Sparkle -p "Sparkle-$SPARKLE_VERSION.tar.xz" -D "$TOOLS" --clobber
  tar -xf "$TOOLS/Sparkle-$SPARKLE_VERSION.tar.xz" -C "$TOOLS" bin
fi

# Prints: sparkle:edSignature="…" length="…"
signature="$(op --account "$ACCOUNT" read "$KEY_REF" | "$TOOLS/bin/sign_update" --ed-key-file - "$ZIP")"
[[ "$signature" == *'sparkle:edSignature="'* ]] || fail "sign_update gave no signature"

tag="native-v$version-$build"
notes="${NOTES:-Ironvale for Mac $version (build $build).}"
gh release create "$tag" "$ZIP" -R "$GH_REPO" --title "Ironvale for Mac $version ($build)" --notes "$notes" --target "$(git -C "$REPO" rev-parse HEAD)"
url="https://github.com/$GH_REPO/releases/download/$tag/$(basename "$ZIP")"

escaped_notes="$(python3 -c 'import html,sys; print(html.escape(sys.argv[1]))' "$notes")"
item="    <item>
      <title>$version ($build)</title>
      <pubDate>$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')</pubDate>
      <sparkle:version>$build</sparkle:version>
      <sparkle:shortVersionString>$version</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>$minimum</sparkle:minimumSystemVersion>
      <description><![CDATA[<p>$escaped_notes</p>]]></description>
      <enclosure url=\"$url\" type=\"application/octet-stream\" $signature />
    </item>"
python3 - "$APPCAST" "$item" <<'PY'
import sys
path, item = sys.argv[1], sys.argv[2]
text = open(path).read()
marker = "<!-- items: newest first -->"
assert marker in text, "appcast is missing the items marker"
open(path, "w").write(text.replace(marker, marker + "\n" + item, 1))
PY
xmllint --noout "$APPCAST"
echo "Added build $build to $APPCAST. Commit it on main to publish."
