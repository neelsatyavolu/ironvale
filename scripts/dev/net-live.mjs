// Checks two-player on the live site in two real Chrome pages: the invite-link flow, and that
// the relay (TURN) servers alone can carry a connection.
//   node scripts/dev/net-live.mjs [--site https://ironvale.n3el.dev/play/]
import { chromium } from 'playwright';

const at = process.argv.indexOf('--site');
const site = at >= 0 ? process.argv[at + 1] : 'https://ironvale.n3el.dev/play/';
let failed = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failed++;
  process.stdout.write(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}\n`);
};
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--use-angle=metal', '--ignore-gpu-blocklist'] });
const open = async (url) => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  return page;
};
const click = (page, name) => page.getByRole('button', { name, exact: true }).filter({ visible: true }).first().click();

const host = await open(site);
await click(host, 'Play with a friend');
await host.getByLabel('Your name').fill('Ada');
await host.locator('button:has-text("Use copy-and-paste codes instead")').filter({ visible: true }).waitFor({ timeout: 15000 });
await click(host, 'Host a game');
await host.waitForFunction(() => document.querySelector('[aria-label="Code to send"]')?.value.includes('join='), null, { timeout: 15000 });
const link = await host.getByLabel('Code to send').inputValue();
check('host gets a link', link.startsWith(`${site}?join=`), link.replace(/join=.*/, 'join=<code>'));

const guest = await open(link);
await guest.getByText('Your friend invited you to a game.').waitFor({ timeout: 30000 });
await guest.getByLabel('Your name').fill('Grace');
await click(guest, 'Join game');
await host.getByText('Connected to Grace').waitFor({ timeout: 30000 });
await guest.getByText('Connected to Ada').waitFor({ timeout: 30000 });
check('both sides connected and see each other by name', true);

// Relay only: two connections in one page that may use nothing but the TURN servers.
const relay = await guest.evaluate(async () => {
  const { iceServers } = await (await fetch('https://ironvale-signal.n3el.dev/ice')).json();
  const config = { iceServers, iceTransportPolicy: 'relay' };
  const a = new RTCPeerConnection(config);
  const b = new RTCPeerConnection(config);
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  const channel = a.createDataChannel('t');
  const got = new Promise((resolve) => {
    b.ondatachannel = (e) => (e.channel.onmessage = (m) => resolve(m.data));
    setTimeout(() => resolve('timeout'), 15000);
  });
  channel.onopen = () => channel.send('through the relay');
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription);
  const data = await got;
  const stats = [...(await a.getStats()).values()];
  const pair = stats.find((s) => s.type === 'candidate-pair' && s.nominated);
  const local = stats.find((s) => s.id === pair?.localCandidateId);
  return { servers: iceServers.length, data, type: local?.candidateType ?? 'none' };
});
check('a message crosses using only the relay servers', relay.data === 'through the relay' && relay.type === 'relay', JSON.stringify(relay));
await browser.close();
process.exit(failed ? 1 : 0);
