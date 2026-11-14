// M7b co-op and duel-bot cross-play (PLAN.md 7, M7b; 5.4): `ivpeer --game` runs a real native match
// (Game + IronvaleAI BotManager + NetMatch) against the web's own NetSession (coop-peer.ts) through a
// local relay running the unchanged signaling/src. The layer 4 browser harness (Playwright against the
// web build) does not exist yet, so the web side here is the Node reference peer: the real session,
// codecs, rules and takeover path, with stand-in bodies instead of a running web game.
//
// Scenarios, both host roles: co-op with 8 bots (the guest shoots bots, the host's bot snapshots and
// match reports must agree), host leaves and the guest takes the remaining enemies over, and the duel
// bot on each side. Every scenario needs zero rejected messages on both sides.
// Run by native/ci/check-m7b.sh, which starts the relay and builds ivpeer.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import type { NetMatchConfig } from '../../../src/net/api';
import type { Vec3 } from '../../../src/net/protocol';
import { runCoopPeer, type CoopPeerOptions, type CoopPeerResult } from './coop-peer';

const SIGNAL = process.env.IRONVALE_INTEROP_SIGNAL ?? '';
const IVPEER = process.env.IRONVALE_IVPEER ?? '';
const MAPS = (process.env.IRONVALE_COOP_MAPS ?? 'railyard,headworks').split(',');
const OUT = new URL('./out/coop/', import.meta.url).pathname;
const ROOT = new URL('../../../', import.meta.url).pathname;
if (process.env.IRONVALE_INTEROP_REQUIRED === '1' && (!SIGNAL || !IVPEER)) {
  throw new Error('IRONVALE_INTEROP_SIGNAL and IRONVALE_IVPEER must be set');
}
const WEB_ORIGIN = 'http://localhost:5311';
const NATIVE_ORIGIN = 'app://ironvale';

interface Line {
  readonly kind: string;
  readonly [key: string]: unknown;
}

function readLog(path: string): Line[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Line);
}

function spawns(mapId: string): { player: Vec3[]; enemy: Vec3[] } {
  const meta = JSON.parse(readFileSync(`${ROOT}native/MapPackages/${mapId}/meta.json`, 'utf8')) as {
    spawns: { player: { position: Vec3 }[]; enemy: { position: Vec3 }[] };
  };
  return { player: meta.spawns.player.map((s) => s.position), enemy: meta.spawns.enemy.map((s) => s.position) };
}

function runNative(args: string[], timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(IVPEER, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

interface Run {
  readonly web: CoopPeerResult;
  readonly native: Line[];
  readonly code: number | null;
  /** The native side's last summary (`final`, or `leaving` when it left). */
  readonly final: Line;
}

async function play(
  label: string,
  nativeRole: 'host' | 'guest',
  config: NetMatchConfig,
  web: Omit<CoopPeerOptions, 'role' | 'signal' | 'origin' | 'codeOut' | 'codeIn' | 'log' | 'config'>,
  nativeArgs: string[] = [],
): Promise<Run> {
  const dir = `${OUT}${label}/`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  vi.stubEnv('VITE_SIGNAL_URL', SIGNAL);
  const webRole = nativeRole === 'host' ? 'guest' : 'host';
  const args = [
    '--game', config.mapId, '--role', nativeRole, '--signal', SIGNAL, '--origin', NATIVE_ORIGIN,
    '--code-out', `${dir}${nativeRole}.code`, '--code-in', `${dir}${webRole}.code`, '--log', `${dir}native.jsonl`,
    '--mode', config.mode, '--bots', String(config.botCount), '--rules', config.rules, '--duel-bot', config.duelBot,
    '--difficulty', config.difficulty, '--kill-target', String(config.killTarget), '--timeout', '110', ...nativeArgs,
  ];
  const native = runNative(args, 120_000);
  const result = await runCoopPeer({
    ...web,
    role: webRole,
    signal: SIGNAL,
    origin: WEB_ORIGIN,
    codeOut: `${dir}${webRole}.code`,
    codeIn: `${dir}${nativeRole}.code`,
    log: `${dir}web.jsonl`,
    config,
    timeoutMs: 110_000,
  });
  const code = await native;
  const log = readLog(`${dir}native.jsonl`);
  const final = [...log].reverse().find((line) => line.kind === 'final' || line.kind === 'leaving')!;
  return { web: result, native: log, code, final };
}

const coopConfig = (mapId: string): NetMatchConfig => ({
  mapId, mode: 'coop', rules: 'skirmish', difficulty: 'regular', botCount: 8, killTarget: 10, duelBot: 'none',
});
// Elite, so the one bot finds and finishes its target within the run.
const duelConfig = (mapId: string, duelBot: 'host' | 'guest'): NetMatchConfig => ({
  mapId, mode: 'duel', rules: 'skirmish', difficulty: 'elite', botCount: 1, killTarget: 50, duelBot,
});
/** Native host in a duel with a bot: run until the bot has scored (or 100 s), then end. */
const UNTIL_SCORED = ['--until-score', '1', '--duration', '100'];
/**
 * Where the native host stands while the guest's bot hunts it. At the host's duel spawn the web's own
 * bot often never finishes a player who stands still: the real src/ai BotManager, one elite bot, on
 * Railyard's first player spawn left the player alive for 100 s in 3 of 6 matches (Headworks: 3 of 16),
 * since a few hits a minute heal back. At these spots the web's bot killed in every one of 128 matches
 * (32 seeds at frame steps 1/120, 1/30, 1/15 and 1/10 s), first kill at most 64 s (Railyard) and 84 s
 * (Headworks) after go. Measured with native/Tools/nav-fixtures/skirmish.test.ts:
 *   SKIRMISH_STAND=x,y,z SKIRMISH_BOTS=1 SKIRMISH_DIFFICULTY=elite SKIRMISH_SEEDS=32 SKIRMISH_SECONDS=100 SKIRMISH_DT=...
 */
const HUNTED_STAND: Readonly<Record<string, Vec3>> = { railyard: [20, 0.05, -40], headworks: [31.5, 0.05, 6.5] };

function expectClean(run: Run): void {
  expect(run.web.rejections, 'web side rejected messages').toEqual([]);
  expect(run.native.filter((line) => line.kind === 'reject'), 'native side rejected messages').toEqual([]);
  expect(Number(run.final.rejections)).toBe(0);
  expect(run.native.some((line) => line.kind === 'go'), 'native reached go').toBe(true);
  expect(run.code, 'ivpeer exit code (0: finished with no rejection)').toBe(0);
}

const nativeDeaths = (run: Run, killer: string): number =>
  run.native.filter((line) => line.kind === 'died' && line.victim === 'local' && line.killer === killer).length;

describe.runIf(SIGNAL && IVPEER).each(MAPS)('co-op on %s', (mapId) => {
  const { player, enemy } = spawns(mapId);
  const guestStand = player[1] ?? player[0]!;

  test('native host, 8 bots: the web guest sees every bot, kills 3, and the host agrees', async () => {
    const run = await play(`${mapId}-coop-native-host`, 'host', coopConfig(mapId), {
      stand: guestStand, durationMs: 50_000, killBots: { count: 3, startMs: 2_000 },
    }, ['--duration', '52']);
    expectClean(run);
    expect(run.web.botSpawns).toBe(8);
    expect(run.web.snapshotBots).toBe(8);
    expect(run.web.unknownSnapshotBots).toBe(0);
    expect(run.web.botSnapshots).toBeGreaterThan(200);
    // The guest's kills land on the host and are counted there and in its reports.
    expect(run.web.botDeathsBy['1']).toBe(3);
    expect(Number(run.final.partnerKills)).toBe(3);
    expect(run.web.lastMatch?.guestKills).toBe(3);
    // The host's enemies count matches what the guest saw die.
    const botDeaths = Object.values(run.web.botDeathsBy).reduce((a, b) => a + b, 0);
    expect(run.web.lastMatch?.enemies).toBe(8 - botDeaths);
    expect(Number(run.final.botsAlive)).toBe(8 - botDeaths);
    // Bots fought: they fired at someone (their shots all passed the web's gate).
    expect(run.web.botShots + nativeDeaths(run, 'bot')).toBeGreaterThan(0);
  }, 130_000);

  test('native host leaves: the web guest takes the remaining enemies over', async () => {
    const run = await play(`${mapId}-coop-native-host-leaves`, 'host', coopConfig(mapId), {
      stand: guestStand, durationMs: 40_000, killBots: { count: 2, startMs: 2_000 },
    }, ['--leave-after', '12', '--duration', '40']);
    expectClean(run);
    expect(run.web.peerLeft).toBe(true);
    expect(run.web.takeOver, 'the web session ran its takeover').not.toBeNull();
    // What the guest takes over is what the host still had standing when it left.
    expect(run.web.takeOver?.enemies).toBe(Number(run.final.botsAlive));
    expect(run.web.takeOver?.enemies).toBeGreaterThan(0);
  }, 130_000);

  test('web host leaves: the native guest takes the remaining enemies over', async () => {
    const run = await play(`${mapId}-coop-web-host-leaves`, 'guest', coopConfig(mapId), {
      stand: player[0]!, durationMs: 60_000, fakeBots: Array.from({ length: 8 }, (_, i) => enemy[i % enemy.length]!),
      killFakeAtMs: [2_000, 3_000, 4_000], leaveAtMs: 8_000,
    }, ['--duration', '20']);
    expectClean(run);
    const proxies = run.native.filter((line) => line.kind === 'summary' && Number(line.proxies) > 0);
    expect(Math.max(...proxies.map((line) => Number(line.proxies)))).toBe(8);
    expect(run.native.some((line) => line.kind === 'tookOver' && line.enemies === '5'), 'native took over 5 enemies').toBe(true);
    expect(run.final.tookOver).toBe(true);
    expect(run.final.authority).toBe(true);
    const spawned = run.native.filter((line) => line.kind === 'botSpawned');
    expect(spawned.length).toBe(5);
    expect(spawned.every((line) => line.team === 'bravo')).toBe(true);
    // The match carries on: the bots are drawn and run here now.
    expect(Number(run.final.botsTotal)).toBeGreaterThan(0);
    expect(Number(run.final.drawn)).toBeGreaterThan(0);
  }, 130_000);
});

describe.runIf(SIGNAL && IVPEER).each(MAPS)('duel bot on %s', (mapId) => {
  const { player, enemy } = spawns(mapId);

  test('native host with the bot on its side: the bot scores against the web guest, both tallies agree', async () => {
    const run = await play(`${mapId}-duelbot-native-host-host`, 'host', duelConfig(mapId, 'host'), {
      stand: player[1] ?? enemy[0]!, durationMs: 105_000,
    }, UNTIL_SCORED);
    expectClean(run);
    expect(run.web.botShots).toBeGreaterThan(0);
    expect(run.web.deaths, 'the native bot killed the web player').toBeGreaterThan(0);
    expect(run.native.find((line) => line.kind === 'botSpawned')).toMatchObject({ team: 'alpha', uniform: 'alpha' });
    expect(run.web.botSpawns).toBe(1);
    // Scored by side: every death of the web player is the native host's point.
    expect(Number(run.final.kills)).toBe(run.web.deaths);
    expect(Number(run.final.deaths)).toBe(run.web.peerDeaths);
  }, 130_000);

  test("native host with the guest's bot: the bot hunts the host, its kills are the guest's points", async () => {
    const hunted = HUNTED_STAND[mapId];
    const run = await play(`${mapId}-duelbot-native-host-guest`, 'host', duelConfig(mapId, 'guest'), {
      stand: player[1] ?? enemy[0]!, durationMs: 105_000,
    }, [...UNTIL_SCORED, ...(hunted ? ['--stand', hunted.join(',')] : [])]);
    expectClean(run);
    if (hunted) expect(run.native.some((line) => line.kind === 'stood'), 'the native host stood where the bot is sure to find it').toBe(true);
    expect(nativeDeaths(run, 'bot'), 'the bot killed the native host').toBeGreaterThan(0);
    expect(run.native.find((line) => line.kind === 'botSpawned')).toMatchObject({ team: 'bravo', uniform: 'bravo' });
    expect(Number(run.final.deaths)).toBe(run.web.peerDeaths);
    expect(Number(run.final.kills)).toBe(run.web.deaths);
  }, 130_000);

  test("web host with its bot: the native guest shows it as an enemy and dies to it", async () => {
    const run = await play(`${mapId}-duelbot-web-host-host`, 'guest', duelConfig(mapId, 'host'), {
      stand: player[0]!, durationMs: 15_000, fakeBots: [enemy[0]!], duelBotAttackEveryMs: 4_000,
    }, ['--duration', '17']);
    expectClean(run);
    expect(run.final.proxyTeams).toBe('bravo');
    expect(Number(run.final.botsTotal)).toBe(0);
    expect(nativeDeaths(run, 'proxy')).toBeGreaterThan(0);
    expect(Number(run.final.deaths)).toBe(run.web.peerDeaths);
    expect(Number(run.final.kills)).toBe(run.web.deaths);
  }, 130_000);

  test("web host with the guest's bot: the native guest shows it as a friend and scores its kills", async () => {
    const run = await play(`${mapId}-duelbot-web-host-guest`, 'guest', duelConfig(mapId, 'guest'), {
      stand: player[0]!, durationMs: 15_000, fakeBots: [enemy[0]!], duelBotAttackEveryMs: 4_000,
    }, ['--duration', '17']);
    expectClean(run);
    expect(run.final.proxyTeams).toBe('alpha');
    expect(Number(run.final.kills)).toBe(run.web.deaths);
    expect(run.web.deaths).toBeGreaterThan(0);
  }, 130_000);
});
