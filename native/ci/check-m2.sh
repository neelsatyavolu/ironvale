#!/usr/bin/env bash
# M2 exit check (PLAN.md section 7): map packages and gun exports are reproducible, the committed
# packages match a fresh export, and the Swift collision world matches 10,000 recorded TypeScript
# queries per map (plus the ported tests/world/collision.test.ts).
set -euo pipefail
NATIVE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
EXPORT="$NATIVE/Tools/map-export/run.mjs"
MAPS=(range railyard headworks harbor)
GUNS=(m4a1 mp5 m24 m249 m7 scarh)

step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

step "typecheck map-export page"
(cd "$REPO" && npx tsc --noEmit -p native/Tools/map-export/tsconfig.json)

step "map-export --check (committed packages match a fresh export)"
(cd "$REPO" && node "$EXPORT" --check)

step "full export twice (collision, fixtures, render data, gun GLBs)"
A="$(mktemp -d)"
B="$(mktemp -d)"
trap 'rm -rf "$A" "$B"' EXIT
(cd "$REPO" && node "$EXPORT" --out "$A")
(cd "$REPO" && node "$EXPORT" --out "$B")

step "SHA-256 stable across both runs"
files=()
for m in "${MAPS[@]}"; do
  for f in meta.json collision.bin boundary.bin bvh.bin fixtures/queries.bin render/scene.json render/buffers.bin; do
    files+=("$m/$f")
  done
done
for g in "${GUNS[@]}"; do files+=("guns/$g.glb" "guns/$g.json"); done
for f in "${files[@]}"; do
  [[ -s "$A/$f" ]] || fail "missing or empty $f"
  ha="$(shasum -a 256 "$A/$f" | cut -d' ' -f1)"
  hb="$(shasum -a 256 "$B/$f" | cut -d' ' -f1)"
  [[ "$ha" == "$hb" ]] || fail "$f differs between runs ($ha vs $hb)"
  printf '%s  %s\n' "$ha" "$f"
done

step "swift test: IronvaleWorld and IronvaleMapData"
(cd "$NATIVE/IronvaleKit" && swift test --scratch-path .build-m2 --filter 'IronvaleWorldTests|IronvaleMapDataTests')

printf '\nM2 check passed.\n'
