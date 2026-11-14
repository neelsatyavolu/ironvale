// Golden fixtures for IronvaleNet (M5), computed by the web's own functions: parseSignal and the
// relay message shapes (signaling.ts), parseIceServers (ice.ts) and ClockSync (clock.ts).
// Writes fixtures/net-session.json; with NET_FIXTURES_CHECK=1 it fails if the file is stale.
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { ClockSync } from '../../../src/net/clock';
import { parseIceServers } from '../../../src/net/ice';
import { parseSignal } from '../../../src/net/signaling';

const OUT = new URL('./fixtures/net-session.json', import.meta.url).pathname;

const longSdp = `v=0\r\n${'a=x\r\n'.repeat(2399)}`;
const signalInputs: string[] = [
  '{"type":"offer","sdp":"v=0\\r\\no=- 1 2 IN IP4 127.0.0.1\\r\\n"}',
  '{"type":"answer","sdp":"v=0\\r\\n"}',
  JSON.stringify({ type: 'offer', sdp: longSdp }),
  JSON.stringify({ type: 'offer', sdp: `${longSdp}aa` }),
  '{"type":"offer","sdp":5}',
  '{"type":"candidate","candidate":{"candidate":"candidate:1 1 udp 2122260223 192.168.1.2 54321 typ host generation 0 ufrag AbCd","sdpMid":"0","sdpMLineIndex":0,"usernameFragment":"AbCd"}}',
  '{"type":"candidate","candidate":{"candidate":"candidate:2 1 udp 1 1.2.3.4 1 typ srflx"}}',
  '{"type":"candidate","candidate":{"candidate":"c","sdpMid":7,"sdpMLineIndex":1.5,"usernameFragment":null}}',
  JSON.stringify({ type: 'candidate', candidate: { candidate: 'c', sdpMid: 'm'.repeat(40), sdpMLineIndex: 3, usernameFragment: 'u'.repeat(300) } }),
  JSON.stringify({ type: 'candidate', candidate: { candidate: 'x'.repeat(1001) } }),
  '{"type":"candidate","candidate":"nope"}',
  '{"type":"candidate"}',
  '{"type":"room","peer":false}',
  '{"type":"room","peer":true}',
  '{"type":"room","peer":"yes"}',
  '{"type":"peer","joined":true}',
  '{"type":"peer","joined":false}',
  '{"type":"peer"}',
  '{"type":"bye"}',
  '[]',
  'null',
  '"offer"',
  '{not json',
  '',
  JSON.stringify({ type: 'answer', sdp: 'v=0', extra: 'x'.repeat(12_300) }),
];

const iceInputs: (string | undefined)[] = [
  undefined,
  '',
  'not json',
  '{}',
  '[]',
  '[{"urls":"turn:turn.example.com:3478","username":"u","credential":"c"}]',
  '[{"urls":["stun:a.example:3478","turns:b.example:443?transport=tcp"]}]',
  '[{"urls":"http://bad.example"}]',
  '[{"urls":[]}]',
  `[{"urls":["stun:a","stun:b","stun:c","stun:d","stun:e","stun:f","stun:g","stun:h","stun:i"]}]`,
  `[{"urls":"stun:${'x'.repeat(200)}"}]`,
  '[{"urls":"stun:a","username":5,"credential":true}]',
  '[1,null,"x",{"urls":"turn:ok"}]',
  JSON.stringify(Array.from({ length: 9 }, (_, i) => ({ urls: `stun:s${i}.example` }))),
];

const clockSamples: [number, number, number][] = [
  [100, 5000, 140],
  [200, 5110, 230],
  [300, 5200, 400],
  [400, 5330, 410],
  [500, 5440, 520],
  [600, 5400, 590],
  [700, Number.NaN, 720],
  [800, 5700, 800 + 10_001],
  [900, 5850, 930],
  [1000, 5950, 1010],
  [1100, 6050, 1110],
  [1200, 6160, 1240],
  [1300, 6250, 1320],
  [1400, 6350, 1450],
  [1500, 6450, 1600],
  [1600, 6600, 1700],
];

function build(): unknown {
  const clock = new ClockSync();
  const clockTrace = clockSamples.map(([sentAt, remoteTime, receivedAt]) => {
    clock.addSample(sentAt, remoteTime, receivedAt);
    return { sentAt, remoteTime: Number.isNaN(remoteTime) ? 'NaN' : remoteTime, receivedAt, synced: clock.synced, offset: clock.offset, rtt: clock.rtt, toLocal1e4: clock.toLocal(10_000) };
  });
  return {
    signal: signalInputs.map((input) => ({ input, output: parseSignal(input) })),
    iceServers: iceInputs.map((input) => ({ input: input ?? null, output: parseIceServers(input) })),
    clock: clockTrace,
  };
}

test('net-session fixtures', () => {
  const text = `${JSON.stringify(build(), null, 2)}\n`;
  if (process.env.NET_FIXTURES_CHECK === '1') {
    expect(readFileSync(OUT, 'utf8'), 'native/Tools/interop/fixtures/net-session.json is stale: rerun net-fixtures').toBe(text);
  } else {
    writeFileSync(OUT, text);
  }
});
