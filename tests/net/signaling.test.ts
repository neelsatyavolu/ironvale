import { describe, expect, it } from 'vitest';
import { parseIceServers } from '../../src/net/ice';
import { parseSignal } from '../../src/net/signaling';

describe('parseSignal', () => {
  it('passes descriptions and candidates, keeping only the known fields', () => {
    expect(parseSignal(JSON.stringify({ type: 'offer', sdp: 'v=0', extra: 1 }))).toEqual({ type: 'offer', sdp: 'v=0' });
    expect(parseSignal(JSON.stringify({ type: 'answer', sdp: 'v=0' }))).toEqual({ type: 'answer', sdp: 'v=0' });
    expect(parseSignal(JSON.stringify({ type: 'candidate', candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0, junk: true } }))).toEqual({
      type: 'candidate',
      candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null },
    });
  });

  it('reads what the relay says about the room', () => {
    expect(parseSignal(JSON.stringify({ type: 'room', peer: true }))).toEqual({ type: 'room', peer: true });
    expect(parseSignal(JSON.stringify({ type: 'peer', joined: false }))).toEqual({ type: 'peer', joined: false });
  });

  it('rejects everything else', () => {
    const bad: unknown[] = [
      null,
      7,
      'text',
      {},
      { type: 'offer' },
      { type: 'offer', sdp: 5 },
      { type: 'offer', sdp: 'x'.repeat(13_000) },
      { type: 'candidate' },
      { type: 'candidate', candidate: 'x' },
      { type: 'candidate', candidate: { candidate: 'x'.repeat(2000) } },
      { type: 'room', peer: 'yes' },
      { type: 'peer' },
      { type: 'eval', code: 'alert(1)' },
    ];
    for (const value of bad) expect(parseSignal(JSON.stringify(value))).toBeNull();
    expect(parseSignal('{broken')).toBeNull();
    expect(parseSignal(new ArrayBuffer(3))).toBeNull();
  });
});

describe('parseIceServers', () => {
  it('reads TURN servers from the build setting', () => {
    const raw = JSON.stringify([{ urls: 'turn:turn.example:3478', username: 'u', credential: 'p' }, { urls: ['turns:turn.example:5349?transport=tcp'] }]);
    expect(parseIceServers(raw)).toEqual([{ urls: ['turn:turn.example:3478'], username: 'u', credential: 'p' }, { urls: ['turns:turn.example:5349?transport=tcp'] }]);
  });

  it('gives nothing for a missing or broken setting', () => {
    expect(parseIceServers(undefined)).toEqual([]);
    expect(parseIceServers('')).toEqual([]);
    expect(parseIceServers('{"urls":"turn:x"}')).toEqual([]);
  });

  it('leaves out entries that are not ICE servers', () => {
    const raw = JSON.stringify([{ urls: 'https://example.com' }, { urls: 5 }, null, 'turn:x', { urls: [] }, { urls: 'stun:ok.example:3478', username: 7 }]);
    expect(parseIceServers(raw)).toEqual([{ urls: ['stun:ok.example:3478'] }]);
  });

  it('takes at most six', () => {
    const raw = JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ urls: `turn:t${i}.example:3478` })));
    expect(parseIceServers(raw)).toHaveLength(6);
  });
});
