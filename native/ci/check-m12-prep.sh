#!/usr/bin/env bash
# M12 preparation check (PLAN.md section 7, M12), everything that needs no Apple credentials:
#   1. the licence gate's credit side: every manifest licence is CC0 or CC-BY 4.0, every CC-BY entry is on the
#      Credits screen, every licence text the screen shows is in the app resources (swift test CreditsLicences);
#   2. a Release build with a build number has resolved version keys and no Debug dylibs
#      (Ironvale.debug.dylib, __preview.dylib, anything *.debug.dylib) and does not link one;
#   3. the bundle is complete: Contract, every map package (collision, BVH, render), the gun GLBs, baked
#      characters, manifests, sound meta, every public file in Runtime/bundle-manifest.json with its SHA-256
#      and an allowed licence, the HUD, fonts with OFL text, and the WebRTC licence matching the resolved package;
#   4. the app is self-contained: a copy outside the repository runs an autopilot match under a sandbox profile
#      that denies every read of the repository, and the copy launches through /usr/bin/open -W -n -g.
# Signing, notarization and Sparkle are not checked here; see docs/native-port/RELEASE.md.
#   SCRATCH=dir        swift scratch path (default native/IronvaleKit/.build-m12)
#   DERIVED_DATA=dir   Release build folder (default native/DerivedData-m12)
#   BUILD_NUMBER=n     CFBundleVersion for the Release build (default 1)
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
SCRATCH="${SCRATCH:-$NATIVE/IronvaleKit/.build-m12}"
export DERIVED_DATA="${DERIVED_DATA:-$NATIVE/DerivedData-m12}"
export BUILD_NUMBER="${BUILD_NUMBER:-1}"

step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

step "swift test: licences and credits (CreditsLicences, CreditsPort)"
(cd "$NATIVE/IronvaleKit" && swift test --scratch-path "$SCRATCH" --filter 'CreditsLicences|CreditsPort')

step "Release build (BUILD_NUMBER=$BUILD_NUMBER)"
APP="$(CONFIGURATION=Release "$NATIVE/ci/build-app.sh" | tail -n 1)"
RES="$APP/Contents/Resources"
BIN="$APP/Contents/MacOS/Ironvale"
[[ "$APP" == */Release/Ironvale.app ]] || fail "not a Release build: $APP"

step "version keys"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "CFBundleShortVersionString is '$VERSION'"
[[ "$BUILD" == "$BUILD_NUMBER" ]] || fail "CFBundleVersion is '$BUILD', expected $BUILD_NUMBER"
echo "Ironvale $VERSION ($BUILD)"

step "no Debug dylibs"
DEBUG_DYLIBS="$(find "$APP" \( -name '__preview.dylib' -o -name '*.debug.dylib' \) -print)"
[[ -z "$DEBUG_DYLIBS" ]] || fail "Debug dylibs in a Release build:\n$DEBUG_DYLIBS"
otool -L "$BIN" | grep -qE 'debug\.dylib|__preview' && fail "the Release binary links a Debug dylib"
[[ "$(stat -f %z "$BIN")" -gt 1000000 ]] || fail "the Release binary is a stub launcher ($(stat -f %z "$BIN") bytes)"

step "bundle completeness"
for f in default.metallib hud-atlas.json hud-atlas.png Newsreader.ttf Geist-Regular.ttf Geist-Medium.ttf GeistMono-Regular.ttf \
         GeistMono-Medium.ttf Newsreader-OFL.txt Geist-OFL.txt Licenses/WebRTC-LICENSE.txt Contract/contract.lock \
         Runtime/assets/sounds.json Runtime/src/audio/sound-meta.json Runtime/bundle-manifest.json; do
  [[ -s "$RES/$f" ]] || fail "$f missing from $APP"
done
[[ -d "$APP/Contents/Frameworks/WebRTC.framework" ]] || fail "WebRTC.framework is not embedded"
WEBRTC_LICENSE="$DERIVED_DATA/SourcePackages/checkouts/WebRTC/LICENSE.md"
[[ -f "$WEBRTC_LICENSE" ]] || fail "resolved WebRTC package has no LICENSE.md at $WEBRTC_LICENSE"
cmp -s "$WEBRTC_LICENSE" "$RES/Licenses/WebRTC-LICENSE.txt" || fail "bundled WebRTC licence differs from the resolved package's"
/usr/bin/python3 - "$REPO" "$RES" <<'PY' || fail "bundle is incomplete (above)"
import hashlib, json, sys
from pathlib import Path
repo, res = Path(sys.argv[1]), Path(sys.argv[2])
problems = []
def need(path):
    if not path.is_file() or path.stat().st_size == 0:
        problems.append(f"missing {path.relative_to(res)}")
for meta in sorted((repo / "native/MapPackages").glob("*/meta.json")):
    for name in ("meta.json", "collision.bin", "boundary.bin", "bvh.bin", "render/scene.json", "render/buffers.bin"):
        need(res / "Runtime/native/MapPackages" / meta.parent.name / name)
for gun in sorted((repo / "native/MapPackages/guns").iterdir()):
    need(res / "Runtime/native/MapPackages/guns" / gun.name)
for src in sorted((repo / "native/BakedAssets").rglob("*")):
    if src.is_file() and not src.name.startswith("."):
        need(res / "Runtime" / src.relative_to(repo))
for src in sorted((repo / "native/Contract").rglob("*")):
    if src.is_file() and not src.name.startswith("."):
        need(res / "Contract" / src.relative_to(repo / "native/Contract"))
for src in sorted((repo / "assets").glob("*.json")):
    need(res / "Runtime/assets" / src.name)
manifest = json.loads((res / "Runtime/bundle-manifest.json").read_text())
files = manifest["files"]
if len(files) < 100:
    problems.append(f"bundle-manifest lists only {len(files)} public files")
for record in files:
    path = res / "Runtime" / record["path"]
    if record["license"] not in ("CC0", "CC-BY 4.0", "first-party"):
        problems.append(f"{record['path']}: licence {record['license']}")
    if not path.is_file():
        problems.append(f"missing {record['path']}")
    elif hashlib.sha256(path.read_bytes()).hexdigest() != record["sha256"]:
        problems.append(f"{record['path']}: SHA-256 differs from bundle-manifest.json")
    elif hashlib.sha256((repo / record["path"]).read_bytes()).hexdigest() != record["sha256"]:
        problems.append(f"{record['path']}: stale copy (the repository file changed)")
for p in problems[:30]:
    print("  " + p, file=sys.stderr)
print(f"{len(files)} public files verified; licences {manifest['licences']}")
sys.exit(1 if problems else 0)
PY

step "code signature is intact (ad hoc until Developer ID; docs/native-port/RELEASE.md)"
codesign --verify --deep --strict "$APP"

step "self-contained: a copy outside the repository, with every repository read denied"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ironvale-m12.XXXXXX")"
trap 'pkill -9 -f "$WORK/Ironvale.app/Contents/MacOS/Ironvale" 2>/dev/null || true; rm -rf "$WORK"' EXIT
[[ "$WORK" != "$REPO"* && "$WORK" != "$HOME/Documents"* ]] || fail "temp folder $WORK is inside the repository or ~/Documents"
ditto "$APP" "$WORK/Ironvale.app"
cp "$NATIVE/ci/m4-autopilot.json" "$WORK/"
cat >"$WORK/deny-repo.sb" <<SB
(version 1)
(allow default)
(deny file-read* file-write* (subpath "$REPO"))
SB
# Negative control: the profile really blocks the repository (an explicit --repo must fail to load).
if (cd "$WORK" && timeout 120 sandbox-exec -f deny-repo.sb ./Ironvale.app/Contents/MacOS/Ironvale --autopilot m4-autopilot.json \
      --offscreen --map range --repo "$REPO" --event-log "$WORK/neg.jsonl" -ApplePersistenceIgnoreState YES >/dev/null 2>&1); then
  fail "the sandbox profile did not block a read of $REPO"
fi
for map in range railyard; do
  (cd "$WORK" && timeout 300 sandbox-exec -f deny-repo.sb ./Ironvale.app/Contents/MacOS/Ironvale --autopilot m4-autopilot.json \
      --offscreen --map "$map" --event-log "$WORK/events-$map.jsonl" -ApplePersistenceIgnoreState YES \
      2> >(grep -vE 'Font Descriptor|NSCTFontDescriptor|NSFont(Name|Size)Attribute|^\}|SwiftUICore/Logging' >&2)) \
    || fail "the bundled app failed its autopilot on $map with the repository unreadable"
  grep -q '"autopilotPassed"' "$WORK/events-$map.jsonl" || fail "no autopilotPassed event on $map"
  echo "$map: autopilot passed from bundle data alone"
done

step "launches through /usr/bin/open -W -n -g with no hang"
rm -f "$WORK/open.jsonl"
timeout 240 /usr/bin/open -W -n -g -a "$WORK/Ironvale.app" --args --autopilot "$WORK/m4-autopilot.json" --offscreen --map range \
  --event-log "$WORK/open.jsonl" -ApplePersistenceIgnoreState YES || fail "open -W did not return (hang?) or failed"
grep -q '"autopilotPassed"' "$WORK/open.jsonl" || fail "the app launched by open did not finish its autopilot"

printf '\nM12 prep check passed (Ironvale %s, build %s).\n' "$VERSION" "$BUILD"
