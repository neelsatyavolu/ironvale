#!/usr/bin/env bash
# Bakes the Metal HUD's MTSDF text atlas (PLAN.md 3.9) from the bundled OFL fonts with msdf-atlas-gen
# (brew install msdf-atlas-gen). Writes native/IronvaleApp/Resources/HUD/hud-atlas.{png,json}.
#   build.sh           regenerate
#   build.sh --check   fail when the committed atlas differs from a fresh bake
# Fonts, in atlas order (the JSON's "variants" index): 0 Geist Mono 400, 1 Geist Mono 500, 2 Newsreader 400 (opsz 40),
# 3 Geist 400 (chat lines).
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/../.." && pwd)"
FONTS="$NATIVE/IronvaleApp/Resources/Fonts"
OUT_DIR="${HUD_ATLAS_OUT:-$NATIVE/IronvaleApp/Resources/HUD}"
GEN="$(command -v msdf-atlas-gen || echo /opt/homebrew/bin/msdf-atlas-gen)"
[[ -x "$GEN" ]] || { echo "msdf-atlas-gen not found (brew install msdf-atlas-gen)" >&2; exit 1; }

# Printable ASCII, Latin-1, and the punctuation the HUD writes (middle dot, dashes, quotes, ellipsis).
CHARS='[0x20, 0x7e], [0xa0, 0xff], 0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2026, 0x2022, 0x2212'
ARGS=(-type mtsdf -size 40 -pxrange 6 -yorigin top -format png -pxalign on
      -font "$FONTS/GeistMono-Regular.ttf" -chars "$CHARS" -fontname "GeistMono-Regular"
      -and -font "$FONTS/GeistMono-Medium.ttf" -chars "$CHARS" -fontname "GeistMono-Medium"
      -and -varfont "$FONTS/Newsreader.ttf?opsz=40&wght=400" -chars "$CHARS" -fontname "Newsreader"
      -and -font "$FONTS/Geist-Regular.ttf" -chars "$CHARS" -fontname "Geist-Regular")

bake() {
  local dir=$1
  mkdir -p "$dir"
  "$GEN" "${ARGS[@]}" -imageout "$dir/hud-atlas.png" -json "$dir/hud-atlas.json" -square4 >/dev/null
}

if [[ "${1:-}" == "--check" ]]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  bake "$TMP"
  for f in hud-atlas.png hud-atlas.json; do
    cmp -s "$TMP/$f" "$OUT_DIR/$f" || { echo "FAIL: $OUT_DIR/$f differs from a fresh bake (run native/Tools/hud-font/build.sh)" >&2; exit 1; }
  done
  echo "hud atlas up to date"
else
  bake "$OUT_DIR"
  echo "wrote $OUT_DIR/hud-atlas.png and hud-atlas.json"
fi
