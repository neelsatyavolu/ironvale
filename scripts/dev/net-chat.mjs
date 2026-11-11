// Chat and the duel minimap reveal in two real Chrome pages, connected with pasted codes.
//   node scripts/dev/net-chat.mjs
import { check, connectByPastedCodes, finish, inGame, launch, openPlayer, section, shot, startMatch, until, wait } from './net-lib.mjs';

const browser = await launch();
const host = await openPlayer(browser, 'host', { rooms: false });
const guest = await openPlayer(browser, 'guest', { rooms: false });
await connectByPastedCodes(host, guest);
await startMatch(host, guest, { mode: 'Duel' });
await until(host, (game) => game.phase === 'playing', 30000);
await wait(4500);

section('chat');
const lines = (player) => player.page.locator('.iv-chat__line').allTextContents();
check('the hint shows in a two-player match', await host.page.locator('.iv-chat__hint').isVisible());
await host.page.keyboard.press('KeyT');
const box = host.page.getByLabel('Chat message');
check('T opens the box with nothing typed in it', (await box.isVisible()) && (await box.inputValue()) === '');
await host.page.keyboard.type('wasd while typing <b>x</b>');
const before = await inGame(host, (game) => game.player.position.toArray());
await wait(300);
const after = await inGame(host, (game) => game.player.position.toArray());
check('typing does not move the player', Math.hypot(after[0] - before[0], after[2] - before[2]) < 0.05);
await host.page.keyboard.press('Enter');
await guest.page.locator('.iv-chat__line').first().waitFor({ timeout: 5000 });
check('the guest sees the line with the host name', (await lines(guest))[0] === 'Adawasd while typing <b>x</b>', JSON.stringify(await lines(guest)));
check('the host sees their own line', (await lines(host)).length === 1);
check('the box closes after sending', !(await box.isVisible()));
await guest.page.keyboard.press('KeyT');
await guest.page.keyboard.type('gg');
await guest.page.keyboard.press('Enter');
await host.page.locator('.iv-chat__line').nth(1).waitFor({ timeout: 5000 });
check('the reply arrives', (await lines(host))[1] === 'Gracegg');
await shot(host, 'net-chat');
await host.page.keyboard.press('KeyT');
await host.page.keyboard.press('Escape');
check('Esc closes the box', !(await box.isVisible()));

section('minimap reveal');
const snap = async (name) => {
  const size = host.page.viewportSize();
  await host.page.screenshot({ path: `shots/${name}.png`, clip: { x: size.width - 230, y: 0, width: 230, height: 230 } });
};
// Between reveals the opponent is not on the map; at the next 15 s mark they are, for a moment.
await until(host, (game) => game.time % 15 > 6 && game.time % 15 < 12, 20000);
await snap('net-reveal-off');
await until(host, (game) => game.time >= 15 && game.time % 15 > 0.3 && game.time % 15 < 1.2, 20000);
await snap('net-reveal-on');
process.stdout.write(`clock ${await inGame(host, (game) => game.time)}\n`);

await browser.close();
process.exit(finish([host, guest]));
