// 5.4 layer 3: the native peer (ivpeer) against the web's own NetSession (node-peer.ts) through a
// local relay running the unchanged signaling/src code. Run by native/ci/check-m5.sh, which starts
// the relay and builds ivpeer, then sets IRONVALE_INTEROP_SIGNAL and IRONVALE_IVPEER.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { runNodePeer, type NodePeerResult } from './node-peer';

const SIGNAL = process.env.IRONVALE_INTEROP_SIGNAL ?? '';
const IVPEER = process.env.IRONVALE_IVPEER ?? '';
const RATE_SIGNAL = process.env.IRONVALE_INTEROP_RATELIMIT_SIGNAL ?? '';
const OUT = new URL('./out/', import.meta.url).pathname;
/** The deployed relay, for the nightly smoke test (smoke-deployed.sh). Needs W6 deployed. */
const SMOKE_SIGNAL = process.env.IRONVALE_SMOKE_SIGNAL ?? '';

// check-m5.sh sets this so a missing relay or binary fails instead of skipping.
if (process.env.IRONVALE_INTEROP_REQUIRED === '1' && (!SIGNAL || !IVPEER || !RATE_SIGNAL)) {
  throw new Error('IRONVALE_INTEROP_SIGNAL, IRONVALE_INTEROP_RATELIMIT_SIGNAL and IRONVALE_IVPEER must be set');
}
const WEB_ORIGIN = 'http://localhost:5311';
const NATIVE_ORIGIN = 'app://ironvale';
/** PLAN.md 3.11.1: native trickles at most 24 candidates per attempt; manual codes stay under 6000. */
const MAX_NATIVE_CANDIDATES = 24;
const MAX_CODE_CHARS = 6000;

interface LogLine {
  readonly at: number;
  readonly kind: string;
  readonly ch?: string;
  readonly frame?: string;
  readonly data?: string;
  readonly [key: string]: unknown;
}

function readLog(path: string): LogLine[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LogLine);
}

interface NativeRun {
  readonly code: number | null;
  readonly stderr: string;
}

function runIvpeer(args: string[], timeoutMs: number): Promise<NativeRun> {
  return new Promise((resolve) => {
    const child = spawn(IVPEER, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

/** Frames one side sent on a channel, and the frames the other side received there. */
function frames(log: LogLine[], kind: 'sent' | 'recv', ch: string, filter: (line: LogLine) => boolean = () => true): string[] {
  return log.filter((line) => line.kind === kind && line.ch === ch && filter(line)).map((line) => `${line.frame}:${line.data}`);
}

const isPlayerState = (line: LogLine): boolean => line.frame === 'binary' && (line.data ?? '').startsWith('01');

function assertConversation(native: LogLine[], web: LogLine[], method: string): void {
  const nativeDone = native.at(-1);
  const webDone = web.at(-1);
  expect(nativeDone?.kind, 'native log ends with done').toBe('done');
  expect(webDone?.kind, 'web log ends with done').toBe('done');
  expect(nativeDone?.ok, `native: ${String(nativeDone?.reason)}`).toBe(true);
  expect(webDone?.ok, `web: ${String(webDone?.reason)}`).toBe(true);
  // Zero rejections on either side.
  expect(native.filter((line) => line.kind === 'reject')).toEqual([]);
  expect(web.filter((line) => line.kind === 'reject')).toEqual([]);
  // The reliable channel delivers exactly what was sent, in order, with text and binary intact.
  expect(frames(web, 'recv', 'events')).toEqual(frames(native, 'sent', 'events'));
  expect(frames(native, 'recv', 'events')).toEqual(frames(web, 'sent', 'events'));
  // The script's events all crossed: lobby, ready, load, loaded, go, hits, death, nade, chat, away, bye.
  const kinds = (log: LogLine[], kind: string): string[] =>
    log.filter((line) => line.kind === kind && line.ch === 'events' && line.frame === 'text').map((line) => (JSON.parse(line.data!) as { t: string }).t);
  for (const t of ['hello', 'ready', 'loaded', 'hit', 'death', 'action', 'switch', 'nade', 'boom', 'chat', 'away']) {
    expect(kinds(native, 'recv').concat(kinds(web, 'recv')), `event ${t} crossed`).toContain(t);
  }
  // 10 s of 30 Hz state each way: about 300 frames; unreliable, so allow a little loss on loopback.
  for (const [sender, receiver] of [
    [native, web],
    [web, native],
  ] as const) {
    const sent = frames(sender, 'sent', 'state', isPlayerState);
    const got = frames(receiver, 'recv', 'state', isPlayerState);
    expect(sent.length).toBe(300);
    expect(got.length).toBeGreaterThanOrEqual(Math.floor(sent.length * 0.95));
    // Every state received is one that was sent, byte for byte.
    const sentSet = new Set(sent);
    expect(got.filter((frame) => !sentSet.has(frame))).toEqual([]);
  }
  // Pings were answered: both sides have a round-trip estimate.
  expect(Number(nativeDone?.rttMs)).toBeGreaterThanOrEqual(0);
  expect(Number(webDone?.rttMs)).toBeGreaterThanOrEqual(0);
  // PLAN.md 3.11.1 assertions on the native side.
  expect(Number(nativeDone?.candidatesSent)).toBeGreaterThan(0);
  expect(Number(nativeDone?.candidatesSent)).toBeLessThanOrEqual(MAX_NATIVE_CANDIDATES);
  if (method === 'manual') {
    const codes = nativeDone?.codeChars as number[];
    expect(codes.length).toBe(1);
    expect(codes[0]).toBeLessThan(MAX_CODE_CHARS);
  }
}

interface ScenarioOptions {
  readonly signal?: string;
  /** Origin the Node peer sends: the web page it stands in for. */
  readonly webOrigin?: string;
  readonly extraNativeArgs?: readonly string[];
  readonly label?: string;
}

async function scenario(nativeRole: 'host' | 'guest', method: 'room' | 'manual', options: ScenarioOptions = {}): Promise<void> {
  const signal = options.signal ?? SIGNAL;
  const dir = `${OUT}${options.label ?? `${nativeRole}-${method}`}/`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  vi.stubEnv('VITE_SIGNAL_URL', signal);
  const webRole = nativeRole === 'host' ? 'guest' : 'host';
  // The host's code goes in host.code; the guest's reply (manual) in guest.code.
  const native = runIvpeer(
    [
      '--role', nativeRole, '--method', method, '--signal', signal, '--origin', NATIVE_ORIGIN, ...(options.extraNativeArgs ?? []),
      '--code-out', `${dir}${nativeRole}.code`, '--code-in', `${dir}${webRole}.code`,
      '--log', `${dir}native.jsonl`, '--timeout', '60',
    ],
    70_000,
  );
  const web: Promise<NodePeerResult> = runNodePeer({
    role: webRole, method, signal, origin: options.webOrigin ?? WEB_ORIGIN,
    codeOut: `${dir}${webRole}.code`, codeIn: `${dir}${nativeRole}.code`,
    log: `${dir}web.jsonl`, timeoutMs: 60_000,
  });
  const [nativeRun] = await Promise.all([native, web]);
  expect(nativeRun.stderr).toBe('');
  expect(nativeRun.code).toBe(0);
  assertConversation(readLog(`${dir}native.jsonl`), readLog(`${dir}web.jsonl`), method);
}

describe.skipIf(!SIGNAL || !IVPEER)('layer 3: native against web through the local relay', () => {
  test('native host, web guest, room code', () => scenario('host', 'room'), 90_000);
  test('web host, native guest, room code', () => scenario('guest', 'room'), 90_000);
  test('native host, web guest, copy-and-paste codes', () => scenario('host', 'manual'), 90_000);
  test('web host, native guest, copy-and-paste codes', () => scenario('guest', 'manual'), 90_000);
});

/** The native client's own error reporting against the same relay code. */
async function nativeExpects(name: string, error: string, args: string[]): Promise<void> {
  const dir = `${OUT}${name}/`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const run = await runIvpeer([...args, '--log', `${dir}native.jsonl`, '--expect-error', error, '--timeout', '20'], 30_000);
  const done = readLog(`${dir}native.jsonl`).at(-1);
  expect(done?.reason).toBe(`error ${error}, expected ${error}`);
  expect(run.code).toBe(0);
}

describe.skipIf(!SIGNAL || !IVPEER)('layer 3: native relay errors', () => {
  test('a guest with an unknown room code gets no-room (close 4404)', async () => {
    // A valid code nobody is hosting under: 6 characters from the room alphabet.
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}no-room.code`, 'ZZZZZ9');
    await nativeExpects('no-room', 'no-room', ['--role', 'guest', '--method', 'room', '--signal', SIGNAL, '--code-in', `${OUT}no-room.code`]);
  }, 40_000);

  test('an origin the relay does not list is refused before the upgrade (signal-unreachable)', () =>
    nativeExpects('bad-origin', 'signal-unreachable', ['--role', 'host', '--method', 'room', '--signal', SIGNAL, '--origin', 'app://not-ironvale']), 40_000);
});

describe.skipIf(!RATE_SIGNAL || !IVPEER)('layer 3: production join limit', () => {
  test('past 30 joins a minute the native client reports rate-limited (HTTP 429)', async () => {
    // Use up the limit the relay shares between /ice and room joins, from this address.
    const base = RATE_SIGNAL.replace(/^ws/, 'http');
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) {
      const response = await fetch(`${base}/ice`, { headers: { Origin: NATIVE_ORIGIN } });
      limited = response.status === 429;
    }
    expect(limited).toBe(true);
    await nativeExpects('rate-limited', 'rate-limited', ['--role', 'host', '--method', 'room', '--signal', RATE_SIGNAL, '--code-out', `${OUT}rate-limited.code`]);
  }, 60_000);
});

// Nightly, against the deployed relay (PLAN.md M5 row). REQUIRES W6: the deployed relay must list
// app://ironvale in ALLOWED_ORIGINS. Run through smoke-deployed.sh, which checks that first.
describe.skipIf(!SMOKE_SIGNAL || !IVPEER)('deployed relay smoke (requires W6)', () => {
  const smoke = { signal: SMOKE_SIGNAL, webOrigin: 'https://ironvale.n3el.dev' };
  test('ivpeer host, web guest, room code', () => scenario('host', 'room', { ...smoke, label: 'smoke-room' }), 90_000);
  test('ivpeer host restricted to TURN candidates, web guest, room code', () =>
    scenario('host', 'room', { ...smoke, label: 'smoke-turn', extraNativeArgs: ['--relay-only'] }), 90_000);
});
