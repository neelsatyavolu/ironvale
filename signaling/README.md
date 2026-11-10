# Ironvale signaling

A small relay that lets two players find each other with a six-character room
code. It only carries the few messages WebRTC needs to set up a direct
connection (an offer, an answer and network candidates). Once the two games are
connected they close their sockets and talk to each other directly.

The game works without it: with no relay configured, or when it cannot be
reached, "Play with a friend" falls back to invite and reply codes that the
players copy and paste by hand.

## What it does

- `GET /health` answers `{ "ok": true }`. The game asks this before offering room codes.
- `GET /room/<code>?role=host|guest` upgrades to a WebSocket. One Durable Object
  per code holds the two sockets and passes messages across.

Limits:

- Only origins listed in `ALLOWED_ORIGINS` may connect. A request with no
  `Origin` header is refused.
- Two sockets per room. A second host or a third peer is refused.
- A room closes ten minutes after the host opened it, and at once when the host leaves.
- Messages must be JSON of type `offer`, `answer` or `candidate`, at most 16 KB.
  Anything else is dropped.
- Each socket may send a burst of 40 messages, refilling at 4 a second. A socket
  that goes over is closed.
- 30 connection attempts a minute per client address.
- Nothing is stored. A message for a peer who is not there is dropped. The only
  thing the Durable Object writes is its own expiry alarm.

A refused join is accepted and then closed with a code the game can read,
because a browser cannot see the HTTP status of a failed WebSocket: `4404` no
game under that code, `4409` code in use or room full, `4410` expired,
`4000` expired while connected, `4001` the host left, `4008` too many messages.

## Files

- `src/room.ts`: the rules (admission, origin check, relay checks, rate limit,
  expiry) with no Workers types. Unit tests are in `tests/net/room.test.ts` in
  the game repository.
- `src/index.ts`: the Worker and the Durable Object that apply those rules to
  real sockets.
- `wrangler.jsonc`: one Durable Object namespace (`ROOMS`), one rate limit
  (`JOIN_LIMITER`) and the `ALLOWED_ORIGINS` variable.

## Run it locally

```sh
cd signaling
npm install
npm run dev
```

This serves `http://127.0.0.1:8799` and allows the game's dev server origins
(`http://127.0.0.1:5311` and `http://localhost:5311`). Point a dev page at it
with `?signal=ws://127.0.0.1:8799` in the address (development builds only), or
set `VITE_SIGNAL_URL=ws://127.0.0.1:8799` before starting the dev server.

Checks, from the repository root with the relay running:

```sh
node scripts/dev/net-signal.mjs    # the relay on its own: origin rule, admission, relay, limits
node scripts/dev/net-duel.mjs      # two Chrome pages play a duel through a room code, then through pasted codes
node scripts/dev/net-coop.mjs      # two Chrome pages play co-op
npm test                           # includes tests/net/room.test.ts
```

Type check: `npx tsc --noEmit -p signaling/tsconfig.json` from the repository
root. Run `npm run types` here after changing `wrangler.jsonc`.

## Deploy (owner)

Not deployed yet. It needs a Cloudflare account; the free plan is enough
(SQLite-backed Durable Objects and 100,000 requests a day).

1. Put the origins the game is served from in `ALLOWED_ORIGINS` in
   `wrangler.jsonc`, comma separated. Keep `tauri://localhost` for the Mac app.
   For example: `"https://ironvale.example,tauri://localhost"`.
2. Deploy:

   ```sh
   cd signaling
   npm install
   npx wrangler login
   npx wrangler deploy
   ```

   Wrangler prints the address, of the form
   `https://ironvale-signaling.<account>.workers.dev`.
3. Check it: `curl https://ironvale-signaling.<account>.workers.dev/health`
   should print `{"ok":true}`.
4. Build the game with the relay's address:

   ```sh
   VITE_SIGNAL_URL=wss://ironvale-signaling.<account>.workers.dev npm run build
   ```

To serve it from your own domain instead, add
`"routes": [{ "pattern": "signal.example.com", "custom_domain": true }]` to
`wrangler.jsonc` before deploying and use that host in `VITE_SIGNAL_URL`.

`npx wrangler tail` shows live logs. To take it down: `npx wrangler delete`.

## Players behind strict routers

The game uses two public STUN servers (`stun.cloudflare.com:3478` and
`stun.l.google.com:19302`). That connects most home networks. Some mobile,
campus and office networks need a TURN relay as well. The game accepts extra
servers at build time:

```sh
VITE_ICE_SERVERS='[{"urls":"turn:turn.example.com:3478","username":"user","credential":"secret"}]' npm run build
```

Anything in a build is public, so use credentials that are meant to be public
or short-lived. Cloudflare Realtime TURN issues short-lived credentials from a
key and token; handing those out from this Worker is not built yet.
