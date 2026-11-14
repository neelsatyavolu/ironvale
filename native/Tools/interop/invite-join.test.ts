// M10 exit criterion: "the ironvale://join scheme and pasted ?join= links both join a room". The web's own
// NetSession (node-peer.ts) hosts a room on the local relay (the unchanged signaling/src); the native app
// joins it twice, once launched by macOS with `ironvale://join?code=CODE` (delivered through
// `application(_:open:)`, then the invited view's "Join game") and once with
// `https://ironvale.n3el.dev/?join=CODE` in the friend screen's "Link or code" field. Each run must reach
// a connected lobby on both sides: the relay pairs them, WebRTC opens, and each side receives the
// other's hello. Run by native/ci/check-m10.sh, which starts the relay and builds the app, then sets
// IRONVALE_INTEROP_SIGNAL and IRONVALE_APP.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { runNodePeer, type NodePeerResult } from './node-peer';

const SIGNAL = process.env.IRONVALE_INTEROP_SIGNAL ?? '';
const APP = process.env.IRONVALE_APP ?? '';
const OUT = new URL('./out/invite-join/', import.meta.url).pathname;
const WEB_ORIGIN = 'http://localhost:5311';
const WEB_NAME = 'Web';
/** Seconds the app stays in the connected lobby before it leaves and quits. */
const CONNECTED_SECONDS = 3;
const RUN_TIMEOUT_MS = 90_000;

if (process.env.IRONVALE_INTEROP_REQUIRED === '1' && (!SIGNAL || !APP)) {
  throw new Error('IRONVALE_INTEROP_SIGNAL and IRONVALE_APP must be set');
}

interface LogLine {
  readonly kind: string;
  readonly [key: string]: unknown;
}

function readLog(path: string): LogLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LogLine);
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8').trim();
      if (text) return text;
    }
    await wait(50);
  }
  throw new Error(`timed out waiting for ${path}`);
}

/**
 * A copy of the app under its own name and bundle id, so other agents' `pkill`/`quit app "Ironvale"` never
 * reach it. It keeps no URL types: `open -a COPY URL` hands the URL to this copy directly, and the test
 * never registers a second ironvale:// handler with Launch Services.
 */
function isolatedApp(): { app: string; binary: string } {
  const app = join(OUT, 'IronvaleM10.app');
  execFileSync(join(import.meta.dirname, 'isolate-app.sh'), [APP, app]);
  // Its own defaults domain too: the player name this test sets must not land in the M6 copy's.
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier dev.n3el.ironvale.m10', join(app, 'Contents/Info.plist')]);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app]);
  const binary = join(app, 'Contents/MacOS/IronvaleM6');
  expect(existsSync(binary), binary).toBe(true);
  return { app, binary };
}

/** Launches through Launch Services (`open`), as macOS does for a clicked link, and waits for the app to quit. */
function launch(app: string, binary: string, url: string | null, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const openArgs = ['-W', '-n', '-g', '-a', app, ...(url ? [url] : []), '--args', ...args];
    const child = spawn('/usr/bin/open', openArgs, { stdio: ['ignore', 'ignore', 'inherit'] });
    const timer = setTimeout(() => {
      spawn('/usr/bin/pkill', ['-9', '-f', binary]);
    }, RUN_TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

interface JoinRun {
  readonly native: LogLine[];
  readonly web: LogLine[];
  readonly webResult: NodePeerResult;
  readonly code: string;
  readonly exit: number | null;
}

async function joinRoom(name: string, path: 'url' | 'paste', nativeName: string, app: { app: string; binary: string }): Promise<JoinRun> {
  const dir = join(OUT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const codeOut = join(dir, 'room-code.txt');
  const webLog = join(dir, 'web.jsonl');
  const nativeLog = join(dir, 'native.jsonl');
  // The web session reads its relay from the build's VITE_SIGNAL_URL, as interop.test.ts sets it.
  vi.stubEnv('VITE_SIGNAL_URL', SIGNAL);
  const host = runNodePeer({
    role: 'host',
    method: 'room',
    signal: SIGNAL,
    origin: WEB_ORIGIN,
    codeOut,
    codeIn: join(dir, 'unused-code-in.txt'),
    log: webLog,
    name: WEB_NAME,
    timeoutMs: RUN_TIMEOUT_MS,
  });
  const code = await waitForFile(codeOut, 30_000);
  const args = ['--signal', SIGNAL, '--net-name', nativeName, '--lobby-log', nativeLog, '--lobby-quit-connected', String(CONNECTED_SECONDS)];
  const exit =
    path === 'url'
      ? await launch(app.app, app.binary, `ironvale://join?code=${code}`, [...args, '--accept-invite'])
      : await launch(app.app, app.binary, null, [...args, '--paste-join', `https://ironvale.n3el.dev/?join=${code}`]);
  // The native side said bye: the web host ends with peer-left.
  const webResult = await host;
  return { native: readLog(nativeLog), web: readLog(webLog), webResult, code, exit };
}

function assertJoined(run: JoinRun, nativeName: string): void {
  const { native, web, code } = run;
  expect(run.exit, 'open -W exit status').toBe(0);
  // Native: guest, through the relay room, connected to the web host, who said hello.
  const lobby = native.filter((line) => line.kind === 'lobby');
  const steps = lobby.map((line) => line.step);
  expect(steps, 'native lobby steps').toContain('opening');
  expect(steps, 'native lobby steps').toContain('connecting');
  const connected = lobby.find((line) => line.step === 'connected');
  expect(connected, `native never connected: ${JSON.stringify(lobby)}`).toBeDefined();
  expect(connected?.role).toBe('guest');
  expect(lobby.filter((line) => line.error !== '' && line.step !== 'idle')).toEqual([]);
  const helloFromWeb = native.filter((line) => line.kind === 'recv' && String(line.data).includes('"t":"hello"'));
  expect(helloFromWeb.map((line) => (JSON.parse(String(line.data)) as { name: string }).name)).toContain(WEB_NAME);
  expect(lobby.some((line) => line.step === 'connected' && line.peerName === WEB_NAME), 'peer name in the lobby').toBe(true);
  expect(native.filter((line) => line.kind === 'reject')).toEqual([]);
  expect(native.find((line) => line.kind === 'leave'), 'native left after the connected lobby').toBeDefined();
  // Web: its room got this guest, connected, and the native hello carried the native name.
  const webPhases = web.filter((line) => line.kind === 'phase').map((line) => line.phase);
  expect(webPhases).toEqual(expect.arrayContaining(['opening', 'waiting', 'connecting', 'connected']));
  const helloFromNative = web
    .filter((line) => line.kind === 'recv' && line.ch === 'events' && String(line.data).includes('"t":"hello"'))
    .map((line) => (JSON.parse(String(line.data)) as { name: string }).name);
  expect(helloFromNative).toContain(nativeName);
  expect(web.filter((line) => line.kind === 'reject')).toEqual([]);
  expect(run.webResult.reason, 'the web host saw the native guest leave').toContain('peer-left');
  expect(code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
}

describe.skipIf(!SIGNAL || !APP)('M10: invite links join a room hosted by the web session', () => {
  const app = SIGNAL && APP ? (mkdirSync(OUT, { recursive: true }), isolatedApp()) : { app: '', binary: '' };

  test('launched by ironvale://join?code=CODE', async () => {
    const run = await joinRoom('url', 'url', 'NativeURL', app);
    const invite = run.native.find((line) => line.kind === 'invite');
    expect(invite?.url).toBe(`ironvale://join?code=${run.code}`);
    expect(invite?.code).toBe(run.code);
    expect(run.native.find((line) => line.kind === 'join')).toMatchObject({ source: 'url', code: run.code });
    assertJoined(run, 'NativeURL');
  }, 150_000);

  test('a pasted https://ironvale.n3el.dev/?join=CODE link', async () => {
    const run = await joinRoom('paste', 'paste', 'NativePaste', app);
    expect(run.native.find((line) => line.kind === 'join')).toMatchObject({
      source: 'paste',
      text: `https://ironvale.n3el.dev/?join=${run.code}`,
    });
    expect(run.native.some((line) => line.kind === 'invite')).toBe(false);
    assertJoined(run, 'NativePaste');
  }, 150_000);
});
