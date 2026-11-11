#!/bin/sh
# Renders every pose in map-headworks-poses.json to shots/map-headworks-<name>.png.
# Usage: scripts/dev/map-headworks-shots.sh [port] [extra query, e.g. "&q=low"]
cd "$(dirname "$0")/../.." || exit 1
node -e 'const p=require("./scripts/dev/map-headworks-poses.json");for(const [k,v] of Object.entries(p))console.log(k+" "+v)' | while read -r name pose; do
  scripts/dev/map-headworks-shot.sh "$name" "$pose" "$2" "${1:-5311}" | grep -v "status: ok" | grep -v "^/"
done
