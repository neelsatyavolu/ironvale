#!/bin/sh
# Shoots every pose in map-harbor-poses.json: shots/harbor-<prefix>-<name>.png
# PORT picks the dev server (default 5311).
prefix="${1:-now}"
port="${PORT:-5311}"
cd "$(dirname "$0")/../.." || exit 1
node -e '
const p = require("./scripts/dev/map-harbor-poses.json");
for (const s of p.poses) console.log(s.name + " " + p.params + "&pose=" + s.pose);
' | while read -r name params; do
  npm run shot --silent -- --out "harbor-$prefix-$name" --params "$params" --wait 3000 --port "$port" 2>&1 | head -4
done
