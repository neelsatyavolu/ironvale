#!/usr/bin/env bash
# M4 exit check (PLAN.md section 7, M4 row): offline playable sim.
#   1. sim fixtures are current: native/Tools/sim-fixtures --check regenerates native/Contract/sim from src/
#      (PlayerController traces on a box world and every map, WeaponMachine traces, grenade trajectories,
#      constants, stand-in gun shapes) and fails on any difference
#   2. swift test: IronvaleSim (PlayerController fixtures within 1e-5 m on the box world and each map, the
#      ported weapons / grenade / hitbox / ballistics test cases, the autopilot scenario headless),
#      IronvalePlatform (key codes), IronvaleViewModel (stand-in guns)
#   3. app build (Debug by default: M4 gates behaviour, not speed; CONFIGURATION=Release to override)
#   4. the app runs native/ci/m4-autopilot.json (--autopilot --offscreen) on Range, Railyard and Headworks:
#      walk, crouch, jump, fire all six weapons, reload, grenade, die, respawn. Gate: the app exits 0 (its own
#      check passed) AND this script finds every M4 event in order in the app's event log.
# Run with SKIP_BUILD=1 to reuse a built app at $APP.
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
SCRATCH="${SCRATCH:-.build-m4}"
OUT="${OUT:-$NATIVE/IronvaleKit/$SCRATCH/m4-check}"  # git-ignored (.build*)
MAPS=(range railyard headworks)
mkdir -p "$OUT"

step() { printf '\n== %s\n' "$*"; }

step "sim fixtures are current (native/Tools/sim-fixtures --check)"
"$NATIVE/Tools/sim-fixtures/run.sh" --check

step "swift test (IronvaleSim, IronvalePlatform, IronvaleViewModel)"
(cd "$NATIVE/IronvaleKit" && swift test --scratch-path "$SCRATCH" --filter 'IronvaleSimTests|IronvalePlatformTests|IronvaleViewModelTests' 2>&1 \
  | tee "$OUT/swift-test.log" | grep -E '^player-|grenade trajectories|Test run|✘' || true)
if grep -qE '✘|Test run with .* failed|error:' "$OUT/swift-test.log" || ! grep -q 'Test run with .* passed' "$OUT/swift-test.log"; then
  echo "FAIL: swift test (see $OUT/swift-test.log)" >&2
  exit 1
fi

if [[ "${SKIP_BUILD:-0}" != 1 ]]; then
  step "xcodegen + xcodebuild (${CONFIGURATION:-Debug})"
  APP="$(CONFIGURATION="${CONFIGURATION:-Debug}" DERIVED_DATA="${DERIVED_DATA:-$NATIVE/DerivedData-m4}" "$NATIVE/ci/build-app.sh" | tail -n 1)"
fi
BIN="$APP/Contents/MacOS/Ironvale"
echo "app: $APP"

FAILED=0
for map in "${MAPS[@]}"; do
  step "autopilot on $map"
  LOG="$OUT/events-$map.jsonl"
  rm -f "$LOG"
  touch "$LOG"
  # -ApplePersistenceIgnoreState: an earlier run that was killed must not leave a modal "reopen windows?" prompt.
  if ! "$BIN" --autopilot "$NATIVE/ci/m4-autopilot.json" --offscreen --map "$map" --event-log "$LOG" --repo "$REPO" \
      -ApplePersistenceIgnoreState YES 2> >(grep -vE 'Font Descriptor|NSCTFontDescriptor|NSFont(Name|Size)Attribute|^\}|SwiftUICore/Logging' >&2); then
    echo "FAIL: the app's autopilot check failed on $map" >&2
    FAILED=1
  fi
  # Independent reading of the log: each M4 event, in order (GameEvent names, src/game/contracts.ts).
  node - "$LOG" "$map" <<'JS' || FAILED=1
const fs = require('fs');
const [log, map] = process.argv.slice(2);
const text = fs.readFileSync(log, 'utf8').trim();
const lines = text ? text.split('\n').map((line) => JSON.parse(line)) : [];
const weapons = ['m4a1', 'mp5', 'm24', 'm249', 'm7', 'scarh'];
const want = [['spawned'], ['footstep'], ['crouched'], ['jumped'], ['landed']];
weapons.forEach((w, i) => {
  if (i > 0) want.push(['weaponSwitch', 'weapon', w]);
  want.push(['shotFired', 'weapon', w]);
});
want.push(['weaponAction', 'stage', 'magOut'], ['weaponAction', 'stage', 'magIn'], ['grenadeThrown'], ['grenadeExploded'],
  ['playerHurt'], ['died'], ['spawned']);
let at = 0;
const missing = [];
for (const [event, key, value] of want) {
  const found = lines.findIndex((e, i) => i >= at && e.event === event && (!key || e[key] === value));
  if (found < 0) missing.push(key ? `${event} ${key}=${value}` : event);
  else at = found + 1;
}
const counts = {};
for (const e of lines) counts[e.event] = (counts[e.event] ?? 0) + 1;
const render = lines.find((e) => e.event === 'renderUnavailable');
console.log(`${map}: ${lines.length} log lines; shots ${counts.shotFired ?? 0}, footsteps ${counts.footstep ?? 0}, deaths ${counts.died ?? 0}, spawns ${counts.spawned ?? 0}`);
if (render) console.log(`${map}: WARNING map renderer unavailable (sim ran without map geometry): ${render.reason}`);
if (!lines.some((e) => e.event === 'autopilotPassed')) missing.push('autopilotPassed');
if (missing.length) {
  console.error(`FAIL ${map}: missing in order: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`${map}: every M4 event in order`);
JS
done

step "result"
if [[ "$FAILED" == 1 ]]; then
  printf '\nM4 check FAILED.\n'
  exit 1
fi
printf '\nM4 check passed.\n'
