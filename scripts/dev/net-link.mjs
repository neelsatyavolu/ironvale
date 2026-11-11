// The invite-link flow in two real Chrome pages: the host gets a link, the guest opens it,
// sets a name and joins. Needs the local signaling Worker (cd signaling && npm run dev).
//   node scripts/dev/net-link.mjs
import { arg, check, clickButton, enterFriendScreen, finish, launch, openPlayer, section, shot, waitConnected } from './net-lib.mjs';

const signal = arg('signal', 'ws://127.0.0.1:8799');
const browser = await launch();
const host = await openPlayer(browser, 'host');

section('host gets a link');
await enterFriendScreen(host, 'Ada');
await host.page.locator('button:has-text("Use copy-and-paste codes instead")').filter({ visible: true }).waitFor({ timeout: 10000 });
await clickButton(host.page, 'Host a game');
const box = host.page.getByLabel('Code to send');
await box.waitFor({ timeout: 10000 });
await host.page.waitForFunction(() => document.querySelector('[aria-label="Code to send"]').value.includes('join='), null, { timeout: 10000 });
const link = await box.inputValue();
check('the host is shown a link with a room code', /^http:\/\/127\.0\.0\.1:\d+\/\?join=[A-Z2-9]{6}$/.test(link), link);
await shot(host, 'net-link-host');

section('guest opens the link');
const guest = await openPlayer(browser, 'guest', { url: `${link}&dev&q=low&signal=${encodeURIComponent(signal)}` });
const invited = guest.page.getByText('Your friend invited you to a game.');
await invited.waitFor({ timeout: 10000 });
check('the join screen opens by itself', await invited.isVisible());
check('the code is taken out of the address', !(await guest.page.evaluate(() => location.search)).includes('join='));
await guest.page.getByLabel('Your name').fill('Grace');
await shot(guest, 'net-link-guest');
await clickButton(guest.page, 'Join game');
await waitConnected(host, guest);
check('host sees the guest by name', await host.page.getByText('Connected to Grace').isVisible());
check('guest sees the host by name', await guest.page.getByText('Connected to Ada').isVisible());
await shot(guest, 'net-link-lobby');

await browser.close();
process.exit(finish([host, guest]));
