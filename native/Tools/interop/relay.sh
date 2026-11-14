#!/usr/bin/env bash
# Local signaling relay for the interop tests (PLAN.md 5.4 layer 3): the unchanged signaling/src
# under `wrangler dev`, with the interop bindings.
#   relay.sh [PORT] [CONFIG]   foreground; PORT defaults to 8790, CONFIG to wrangler.interop.jsonc
# Wait for readiness with: until curl -sf http://127.0.0.1:PORT/health; do sleep 0.2; done
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
PORT="${1:-8790}"
CONFIG="${2:-$HERE/wrangler.interop.jsonc}"
WRANGLER="$ROOT/signaling/node_modules/.bin/wrangler"
[[ -x "$WRANGLER" ]] || { echo "relay.sh: run 'npm ci' in signaling/ first" >&2; exit 1; }
# Local state lives under native/Tools/interop/.wrangler (git-ignored), never the deployed relay.
exec "$WRANGLER" dev --config "$CONFIG" --ip 127.0.0.1 --port "$PORT" --local \
  --persist-to "$HERE/.wrangler/state-$PORT" --show-interactive-dev-session=false --log-level warn
