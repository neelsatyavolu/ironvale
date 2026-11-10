#!/bin/sh
# Contact sheets of the Pinewood screenshots, six per sheet in file-name order, for quick review.
# Usage: scripts/dev/map-pinewood-sheet.sh [suffix, e.g. -high] [out dir]
cd "$(dirname "$0")/../../shots" || exit 1
suffix="${1:--high}"
out="${2:-.}"
set -- $(ls map-pinewood-*"$suffix".png | grep -v sheet)
n=1
while [ $# -gt 0 ]; do
  batch=""
  i=0
  while [ $i -lt 6 ] && [ $# -gt 0 ]; do batch="$batch $1"; shift; i=$((i + 1)); done
  montage $batch -resize 800x450 -tile 2x3 -geometry +2+2 -background black "$out/map-pinewood-sheet$suffix-$n.jpg"
  n=$((n + 1))
done
