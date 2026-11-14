#!/usr/bin/env bash
# M10 exit check (PLAN.md section 7): every screen and HUD element of the audio-ui inventory exists and is
# reachable by keyboard alone; settings JSON round-trips against the web fixtures; the credits model passes
# the ported credits test (and gives CREDITS.md); ironvale://join and pasted ?join= links both join a room;
# a native host's invite link is https://ironvale.n3el.dev/?join=CODE; the settings, player-name and
# first-run keys round-trip. Also: the HUD's web data, fixtures, minimap layouts and MTSDF atlas are
# regenerated from src/ and the bundled fonts and have not drifted; the Metal HUD renders; the app bundles
# the fonts with their OFL text, the HUD resources, Hud.metal and the ironvale URL scheme. Last, end to end:
# the app joins a room hosted by the web's NetSession (node-peer.ts) on a local relay, once launched by
# ironvale://join?code=CODE and once with https://ironvale.n3el.dev/?join=CODE pasted into the join field
# (native/Tools/interop/invite-join.test.ts).
#   M10_RELAY_PORT=n   local relay port (default 8797)
#   SCRATCH=dir        swift scratch path (default native/IronvaleKit/.build-m10)
#   DERIVED_DATA=dir   app build folder (default native/DerivedData-m10)
#   IV_HUD_SNAPSHOTS=dir, IV_UI_SNAPSHOTS=dir   also write the rendered HUD frames and screens as PNGs
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
SCRATCH="${SCRATCH:-$NATIVE/IronvaleKit/.build-m10}"
export DERIVED_DATA="${DERIVED_DATA:-$NATIVE/DerivedData-m10}"
RES="$NATIVE/IronvaleApp/Resources"

step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

step "web UI data and fixtures are current with src/ (M10a screens)"
UI_GENERATED=("$NATIVE/IronvaleKit/Sources/IronvaleUI/Generated/WebUIData.swift" "$NATIVE/Tools/ui-fixtures/fixtures/web-ui-fixtures.json")
before="$(shasum "${UI_GENERATED[@]}")"
(cd "$REPO" && npx vitest run --config native/Tools/ui-fixtures/vitest.config.ts)
[[ "$before" == "$(shasum "${UI_GENERATED[@]}")" ]] || fail "web UI data was out of date with src/ (regenerated; review and keep it)"

step "HUD data, fixtures and minimap layouts are current with src/"
(cd "$REPO" && HUD_FIXTURES_CHECK=1 npx vitest run --config native/Tools/vitest.config.ts native/Tools/ui-fixtures/hud-fixtures.test.ts)

step "HUD MTSDF atlas matches a fresh bake of the bundled fonts"
"$NATIVE/Tools/hud-font/build.sh" --check

step "bundled fonts carry their OFL text"
for f in Newsreader.ttf Geist-Regular.ttf Geist-Medium.ttf GeistMono-Regular.ttf GeistMono-Medium.ttf Newsreader-OFL.txt Geist-OFL.txt; do
  [[ -s "$RES/Fonts/$f" ]] || fail "missing $RES/Fonts/$f"
done
grep -q "SIL Open Font License, Version 1.1" "$RES/Fonts/Geist-OFL.txt" || fail "Geist-OFL.txt is not the OFL"
grep -q "SIL Open Font License, Version 1.1" "$RES/Fonts/Newsreader-OFL.txt" || fail "Newsreader-OFL.txt is not the OFL"

step "swift build"
(cd "$NATIVE/IronvaleKit" && swift build --scratch-path "$SCRATCH")

step "swift test (IronvaleUITests: screens, keyboard, settings, credits, keys, invites, HUD logic, layout, Game-driven HUD, Metal pass)"
(cd "$NATIVE/IronvaleKit" && swift test --scratch-path "$SCRATCH" --filter IronvaleUITests)

step "app bundles the HUD, fonts and URL scheme"
APP="$("$NATIVE/ci/build-app.sh" | tail -n 1)"
for f in hud-atlas.json hud-atlas.png minimap-range.bin minimap-railyard.bin minimap-harbor.bin minimap-headworks.bin \
         Newsreader.ttf Geist-Regular.ttf Geist-Medium.ttf GeistMono-Regular.ttf GeistMono-Medium.ttf Newsreader-OFL.txt Geist-OFL.txt; do
  [[ -s "$APP/Contents/Resources/$f" ]] || fail "$f missing from $APP"
done
for fn in hudVertex hudFragment hudGradeVertex hudGradeFragment; do
  grep -aq "$fn" "$APP/Contents/Resources/default.metallib" || fail "$fn missing from default.metallib"
done
/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes:0:CFBundleURLSchemes:0" "$APP/Contents/Info.plist" | grep -qx ironvale \
  || fail "Info.plist does not register the ironvale URL scheme"

step "invite links join a room: the app (ironvale://join and a pasted ?join= link) against the web's NetSession on a local relay"
INTEROP="$NATIVE/Tools/interop"
PORT="${M10_RELAY_PORT:-8797}"
mkdir -p "$INTEROP/out"
[[ -d "$INTEROP/node_modules/node-datachannel" ]] || (cd "$INTEROP" && npm ci --no-audit --no-fund)
[[ -x "$REPO/signaling/node_modules/.bin/wrangler" ]] || (cd "$REPO/signaling" && npm ci --no-audit --no-fund)
curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && fail "port $PORT is already serving; stop it or set M10_RELAY_PORT"
"$INTEROP/relay.sh" "$PORT" "$INTEROP/wrangler.interop.jsonc" >"$INTEROP/out/relay-m10.log" 2>&1 &
RELAY_PID=$!
kill_tree() { local pid=$1 child; for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done; kill "$pid" 2>/dev/null || true; }
trap 'kill_tree $RELAY_PID' EXIT
for _ in $(seq 1 120); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 || fail "relay did not come up on $PORT; see $INTEROP/out/relay-m10.log"
(cd "$REPO" && IRONVALE_INTEROP_SIGNAL="ws://127.0.0.1:$PORT" IRONVALE_APP="$APP" IRONVALE_INTEROP_REQUIRED=1 \
  npx vitest run --config native/Tools/vitest.config.ts native/Tools/interop/invite-join.test.ts)

printf '\nM10 check passed.\n'
