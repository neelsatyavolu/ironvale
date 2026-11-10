// Screenshots of the "Play with a friend" screens in each state, for checking the interface.
// Needs the signaling Worker running locally for the room-code states: cd signaling && npm run dev
// Usage: node scripts/dev/net-ui.mjs      (writes shots/net-ui-*.png)
import { clickButton, finish, launch, openPlayer, shot, wait } from './net-lib.mjs';

const browser = await launch();
const host = await openPlayer(browser, 'host');
const guest = await openPlayer(browser, 'guest');
const solo = await openPlayer(browser, 'solo', { rooms: false });
const players = [host, guest, solo];
const state = (player) => player.page.evaluate(() => window.__ironvale.game.net.state);
const untilStep = (player, step) => player.page.waitForFunction((want) => window.__ironvale.game.net.state.step === want, step, { timeout: 30000 });

await shot(host, 'net-ui-menu');
for (const player of players) {
  await clickButton(player.page, 'Play with a friend');
  await player.page.getByLabel('Your name').fill(player === host ? 'Ada' : 'Grace');
  await player.page.getByLabel('Your name').blur();
}
await host.page.locator('button:has-text("Use copy-and-paste codes instead")').filter({ visible: true }).waitFor({ timeout: 10000 });
await shot(host, 'net-ui-idle-rooms');
await wait(600);
await shot(solo, 'net-ui-idle-paste');

// A code that no game is waiting under.
await guest.page.locator('button:has-text("Use copy-and-paste codes instead")').filter({ visible: true }).waitFor({ timeout: 10000 });
await guest.page.getByLabel('Room code').fill('ZZZZ99');
await clickButton(guest.page, 'Join');
await guest.page.waitForFunction(() => window.__ironvale.game.net.state.error !== null, null, { timeout: 10000 });
await shot(guest, 'net-ui-error-no-room');

await clickButton(host.page, 'Host a game');
await untilStep(host, 'waiting');
await shot(host, 'net-ui-host-room');
const code = (await state(host)).code;
await guest.page.getByLabel('Room code').fill(code);
await clickButton(guest.page, 'Join');
await untilStep(guest, 'connected');
await untilStep(host, 'connected');
await wait(1500);
await shot(guest, 'net-ui-lobby-guest');
await clickButton(guest.page, 'Ready');
await host.page.getByRole('radio', { name: 'Duel', exact: true }).filter({ visible: true }).click();
await wait(400);
await host.page.mouse.wheel(0, 400);
await wait(200);
await shot(host, 'net-ui-lobby-host-duel');
await shot(guest, 'net-ui-lobby-guest-ready');

// Copy-and-paste: the host's invite and the box for the reply.
await clickButton(solo.page, 'Host a game');
await untilStep(solo, 'waiting');
await shot(solo, 'net-ui-host-invite');
await solo.page.getByLabel('Reply code').fill('IVH1.not-a-reply');
await clickButton(solo.page, 'Connect');
await solo.page.waitForFunction(() => window.__ironvale.game.net.state.error !== null, null, { timeout: 5000 });
await shot(solo, 'net-ui-host-invite-wrong-paste');

await browser.close();
process.exit(finish(players));
