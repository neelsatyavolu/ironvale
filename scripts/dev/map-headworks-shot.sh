#!/bin/sh
# Player-eye screenshot of Headworks. Usage: scripts/dev/map-headworks-shot.sh <name> "x,y,z,yawDeg,pitchDeg" [extra query] [port]
# Writes shots/map-headworks-<name>.png at the high tier with no bots.
cd "$(dirname "$0")/../.." || exit 1
node scripts/shot.mjs --out "map-headworks-$1" --params "map=headworks&bots=0&q=high&pose=$2$3" --wait 3000 --port "${4:-5311}" | head -6
