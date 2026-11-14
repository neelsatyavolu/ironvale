#!/usr/bin/env bash
# M7b exit check (PLAN.md section 7, M7b row): bots and co-op cross-play.
#   1. nav-fixtures --check: native/Contract/nav matches what src/ai produces now (nav grids per map,
#      the bot logic fixtures: roles, spawns, perception, aim, gun timing, paths, cover, and the web's
#      headless 8-bot skirmish per map, skirmish.json, the range native skirmishes are held to)
#   2. Swift tests, IronvaleAITests (built per target and run with xctest, so another lane's test
#      target cannot fail this check): nav grid node counts, edge masks, edge layers, cover masks equal
#      the web's per map; the logic fixtures above; the headless 8-bot skirmish on Railyard and Headworks
#   3. app build, then the app's own run of the solo skirmish with 8 bots on Railyard and Headworks:
#      --autopilot native/ci/m7b-autopilot.json --bots 8 --offscreen; the app checks the bot scenario
#      (BotScenarioMonitor) and exits 0, and this script re-reads the event log on its own
#   4. co-op and duel-bot cross-play: `ivpeer --game` (a real native match with bots) against the web's
#      NetSession (native/Tools/interop/coop-peer.ts) through a local relay running the unchanged
#      signaling/src: co-op in both host roles including host-leaves takeover each way, and the duel bot
#      on each side in both host roles; zero rejected messages on either side.
#      This is the Node reference peer standing in for the browser: the layer 4 Playwright harness
#      (web build against the native app) does not exist yet.
# Overrides: SCRATCH (swift scratch path), DERIVED_DATA, SKIP_BUILD=1 with APP=..., M7B_RELAY_PORT,
# IRONVALE_COOP_MAPS (default railyard,headworks).
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$NATIVE/.." && pwd)"
INTEROP="$NATIVE/Tools/interop"
SCRATCH="${SCRATCH:-$NATIVE/IronvaleKit/.build-m7b}"
DERIVED_DATA="${DERIVED_DATA:-$NATIVE/DerivedData-m7b}"
OUT="${OUT:-$SCRATCH/m7b-check}"
PORT="${M7B_RELAY_PORT:-8796}"
MAPS=(railyard headworks)
mkdir -p "$OUT" "$INTEROP/out"

step() { printf '\n== %s\n' "$*"; }

RELAY_PID=""
kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}
cleanup() { [[ -n "$RELAY_PID" ]] && kill_tree "$RELAY_PID"; return 0; }
trap cleanup EXIT

step "nav-fixtures --check (src/ai -> native/Contract/nav)"
"$NATIVE/Tools/nav-fixtures/run.sh" --check

step "swift tests (IronvaleAITests)"
(cd "$NATIVE/IronvaleKit" && swift build --scratch-path "$SCRATCH" --target IronvaleAITests)
BIN="$(cd "$NATIVE/IronvaleKit" && swift build --scratch-path "$SCRATCH" --show-bin-path)"
xcrun xctest "$BIN/IronvaleAITests.xctest" 2>&1 | tee "$OUT/ai-tests.log" | grep -E '✘|^nav |^skirmish |^bot war |Test run' || true
grep -q '✔ Test run with .* passed' "$OUT/ai-tests.log" || { echo "FAIL: IronvaleAITests (see $OUT/ai-tests.log)" >&2; exit 1; }

if [[ "${SKIP_BUILD:-0}" != 1 ]]; then
  step "xcodegen + xcodebuild (${CONFIGURATION:-Debug})"
  APP="$(CONFIGURATION="${CONFIGURATION:-Debug}" DERIVED_DATA="$DERIVED_DATA" "$NATIVE/ci/build-app.sh" | tail -n 1)"
fi
echo "app: $APP"

FAILED=0
for map in "${MAPS[@]}"; do
  step "solo skirmish, 8 bots, autopilot on $map"
  LOG="$OUT/events-$map.jsonl"
  rm -f "$LOG"
  if ! "$APP/Contents/MacOS/Ironvale" --autopilot "$NATIVE/ci/m7b-autopilot.json" --bots 8 --offscreen --map "$map" \
      --event-log "$LOG" --repo "$ROOT" -ApplePersistenceIgnoreState YES \
      2> >(grep -vE 'Font Descriptor|NSCTFontDescriptor|NSFont(Name|Size)Attribute|^\}|SwiftUICore/Logging' >&2); then
    echo "FAIL: the app's bot scenario failed on $map" >&2
    FAILED=1
  fi
  # Independent reading of the log: 8 bots spawned, they moved (footsteps), as many fired as in the web's
  # own matches on this map (native/Contract/nav/skirmish.json, from src/ai), and they hit the player.
  node - "$LOG" "$map" "$NATIVE/Contract/nav/skirmish.json" <<'JS' || FAILED=1
const fs = require('fs');
const [log, map, referencePath] = process.argv.slice(2);
const web = JSON.parse(fs.readFileSync(referencePath, 'utf8')).maps[map].botsThatFired;
const lines = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const spawned = lines.filter((e) => e.event === 'spawned');
const player = spawned[0]?.combatant;
const botIds = new Set(spawned.map((e) => e.combatant).filter((id) => id !== player));
const shots = lines.filter((e) => e.event === 'shotFired' && botIds.has(e.shooter));
const hits = lines.filter((e) => e.event === 'combatantHit' && e.target === player && botIds.has(e.attacker));
const summary = lines.find((e) => e.event === 'botScenario');
const shooters = new Set(shots.map((e) => e.shooter)).size;
console.log(`${map}: ${botIds.size} bots, ${shots.length} bot shots by ${shooters} bots (web ${web.min} to ${web.max}), ${hits.length} hits on the player; app: ${JSON.stringify(summary)}`);
const problems = [];
if (botIds.size !== 8) problems.push(`${botIds.size} bots spawned, want 8`);
if (shooters < web.min || shooters > web.max) problems.push(`${shooters} bots fired, the web's matches have ${web.min} to ${web.max}`);
if (hits.length === 0) problems.push('no bot hit the player');
if (!summary) problems.push('no botScenario line');
if (!lines.some((e) => e.event === 'autopilotPassed')) problems.push('no autopilotPassed');
if (problems.length) { console.error(`FAIL ${map}: ${problems.join('; ')}`); process.exit(1); }
JS
done

step "interop dependencies"
[[ -d "$INTEROP/node_modules/node-datachannel" ]] || (cd "$INTEROP" && npm ci --no-audit --no-fund)
[[ -x "$ROOT/signaling/node_modules/.bin/wrangler" ]] || (cd "$ROOT/signaling" && npm ci --no-audit --no-fund)

step "typecheck native/Tools"
(cd "$ROOT" && npx tsc --noEmit -p native/Tools/tsconfig.json)

step "swift build ivpeer"
(cd "$NATIVE/IronvaleKit" && swift build --scratch-path "$SCRATCH" --product ivpeer)
IVPEER="$BIN/ivpeer"
[[ -x "$IVPEER" ]] || { echo "FAIL: $IVPEER missing" >&2; exit 1; }

step "local relay (signaling/src under wrangler dev) on $PORT"
if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "FAIL: port $PORT is already serving; stop it or set M7B_RELAY_PORT" >&2
  exit 1
fi
"$INTEROP/relay.sh" "$PORT" "$INTEROP/wrangler.interop.jsonc" >"$OUT/relay.log" 2>&1 &
RELAY_PID=$!
for _ in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "http://127.0.0.1:$PORT/health" >/dev/null || { echo "FAIL: relay did not come up; see $OUT/relay.log" >&2; exit 1; }

step "co-op and duel-bot cross-play: native against the web's NetSession"
(cd "$ROOT" && IRONVALE_INTEROP_SIGNAL="ws://127.0.0.1:$PORT" IRONVALE_IVPEER="$IVPEER" IRONVALE_INTEROP_REQUIRED=1 \
  npx vitest run --config native/Tools/vitest.config.ts native/Tools/interop/coop.test.ts) || FAILED=1

step "result"
if [[ "$FAILED" == 1 ]]; then
  printf '\nM7b check FAILED.\n'
  exit 1
fi
printf '\nM7b check passed. Logs: %s, %s\n' "$OUT" "$INTEROP/out/coop"
