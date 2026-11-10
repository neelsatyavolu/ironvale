// Exercises the signaling Worker running locally (cd signaling && npm run dev).
// Usage: node scripts/dev/net-signal.mjs [--url ws://127.0.0.1:8799] [--origin http://127.0.0.1:5311]
// Checks the origin rule, admission, relay, size and rate limits and what happens when a peer leaves.
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const base = arg('url', 'ws://127.0.0.1:8799');
const origin = arg('origin', 'http://127.0.0.1:5311');
const http = base.replace(/^ws/, 'http');
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const code = () => Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  process.stdout.write(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}\n`);
};

/** Open a socket and collect what happens to it. */
function open(room, role, from = origin) {
  const socket = new WebSocket(`${base}/room/${room}?role=${role}`, { headers: from ? { Origin: from } : {} });
  const state = { socket, messages: [], closed: null, failed: false };
  socket.addEventListener('message', (event) => state.messages.push(String(event.data)));
  socket.addEventListener('close', (event) => (state.closed = { code: event.code, reason: event.reason }));
  socket.addEventListener('error', () => (state.failed = true));
  state.opened = new Promise((resolve) => {
    socket.addEventListener('open', () => resolve(true));
    socket.addEventListener('error', () => resolve(false));
    socket.addEventListener('close', () => resolve(false));
  });
  return state;
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (test, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return true;
    await wait(20);
  }
  return test();
};

const health = await fetch(`${http}/health`, { headers: { Origin: origin } });
check('health answers', health.ok && (await health.json()).ok === true);
check('health allows the game origin to read it', health.headers.get('access-control-allow-origin') === origin);
const foreign = await fetch(`${http}/health`, { headers: { Origin: 'https://evil.example' } });
check('health gives other origins no CORS header', foreign.headers.get('access-control-allow-origin') === null);
check('unknown path is 404', (await fetch(`${http}/nope`)).status === 404);
check('a plain request to a room is refused', (await fetch(`${http}/room/${code()}?role=host`, { headers: { Origin: origin } })).status === 426);

const stranger = open(code(), 'host', 'https://evil.example');
check('a socket from another origin is refused', (await stranger.opened) === false);
const noOrigin = open(code(), 'host', null);
check('a socket with no origin is refused', (await noOrigin.opened) === false);
const badCode = open('abc', 'host');
check('a malformed room code is refused', (await badCode.opened) === false);

const room = code();
const lonely = open(room, 'guest');
await lonely.opened;
await until(() => lonely.closed);
check('a guest with no host is told there is no such game', lonely.closed?.code === 4404, JSON.stringify(lonely.closed));

const host = open(room, 'host');
check('host connects', await host.opened);
await until(() => host.messages.length >= 1);
check('host is told the room is empty', host.messages[0] === JSON.stringify({ type: 'room', peer: false }));

const second = open(room, 'host');
await second.opened;
await until(() => second.closed);
check('a second host is refused', second.closed?.code === 4409, JSON.stringify(second.closed));

const guest = open(room, 'guest');
check('guest connects', await guest.opened);
await until(() => guest.messages.length >= 1 && host.messages.length >= 2);
check('guest is told the host is there', guest.messages[0] === JSON.stringify({ type: 'room', peer: true }));
check('host is told the guest arrived', host.messages[1] === JSON.stringify({ type: 'peer', joined: true }));

const third = open(room, 'guest');
await third.opened;
await until(() => third.closed);
check('a third peer is refused', third.closed?.code === 4409, JSON.stringify(third.closed));

const offer = JSON.stringify({ type: 'offer', sdp: 'v=0' });
host.socket.send(offer);
await until(() => guest.messages.includes(offer));
check('offer reaches the guest', guest.messages.includes(offer));
const answer = JSON.stringify({ type: 'answer', sdp: 'v=0' });
guest.socket.send(answer);
await until(() => host.messages.includes(answer));
check('answer reaches the host', host.messages.includes(answer));

const before = guest.messages.length;
host.socket.send(JSON.stringify({ type: 'chat', text: 'hello' }));
host.socket.send(JSON.stringify({ type: 'offer', sdp: 'x'.repeat(20000) }));
host.socket.send(new Uint8Array([1, 2, 3]));
await wait(300);
check('unknown, oversized and binary messages are not relayed', guest.messages.length === before);

guest.socket.close(1000);
await until(() => host.messages.includes(JSON.stringify({ type: 'peer', joined: false })));
check('host is told the guest left', host.messages.includes(JSON.stringify({ type: 'peer', joined: false })));

const back = open(room, 'guest');
check('another guest can take the free seat', await back.opened);
await until(() => back.messages.length >= 1);
const candidate = JSON.stringify({ type: 'candidate', candidate: { candidate: 'x' } });
for (let i = 0; i < 60; i++) back.socket.send(candidate);
await until(() => back.closed);
check('a flooding socket is closed', back.closed?.code === 4008, JSON.stringify(back.closed));

const last = open(room, 'guest');
await last.opened;
await until(() => last.messages.length >= 1);
host.socket.close(1000);
await until(() => last.closed);
check('the guest is dropped when the host leaves', last.closed?.code === 4001, JSON.stringify(last.closed));
await wait(100);
const reuse = open(room, 'host');
check('the code is free again after the host leaves', await reuse.opened);
reuse.socket.close(1000);

const failed = results.filter((pass) => !pass).length;
process.stdout.write(`${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed === 0 ? 0 : 1);
