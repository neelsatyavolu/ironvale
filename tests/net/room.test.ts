import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  Room,
  admit,
  checkRelay,
  isRoomCode as serverIsRoomCode,
  originAllowed,
  parseAllowedOrigins,
  takeToken,
  type Bucket,
  type Peer,
} from '../../signaling/src/room';
import { ROOM_ALPHABET, makeRoomCode } from '../../src/net/room-code';

/** A socket stand-in that records what the room sends it. */
function peer(): Peer & { sent: string[]; closed: { code: number; reason: string } | null } {
  const record = {
    sent: [] as string[],
    closed: null as { code: number; reason: string } | null,
    send(text: string): void {
      record.sent.push(text);
    },
    close(code: number, reason: string): void {
      record.closed = { code, reason };
    },
  };
  return record;
}

describe('admission', () => {
  it('needs a host first, takes one guest, and refuses a third', () => {
    expect(admit([], 'guest')).toMatchObject({ ok: false, status: 404 });
    expect(admit([], 'host')).toEqual({ ok: true });
    expect(admit(['host'], 'host')).toMatchObject({ ok: false, status: 409 });
    expect(admit(['host'], 'guest')).toEqual({ ok: true });
    expect(admit(['host', 'guest'], 'guest')).toMatchObject({ ok: false, status: 409 });
  });
});

describe('origins', () => {
  const allowed = parseAllowedOrigins(' https://ironvale.example , tauri://localhost,');

  it('parses the list', () => {
    expect(allowed).toEqual(['https://ironvale.example', 'tauri://localhost']);
    expect(parseAllowedOrigins(undefined)).toEqual([]);
  });

  it('accepts listed origins only', () => {
    expect(originAllowed('https://ironvale.example', allowed)).toBe(true);
    expect(originAllowed('tauri://localhost', allowed)).toBe(true);
    expect(originAllowed('https://evil.example', allowed)).toBe(false);
    expect(originAllowed('https://ironvale.example.evil.example', allowed)).toBe(false);
    expect(originAllowed(null, allowed)).toBe(false);
    expect(originAllowed('https://anything', [])).toBe(false);
  });
});

describe('room codes', () => {
  it('agree with the codes the game makes', () => {
    for (let i = 0; i < 50; i++) expect(serverIsRoomCode(makeRoomCode())).toBe(true);
    expect(serverIsRoomCode('abc123')).toBe(false);
    expect(serverIsRoomCode('ABCDEFG')).toBe(false);
    expect(serverIsRoomCode(`${ROOM_ALPHABET.slice(0, 5)}0`)).toBe(false);
  });
});

describe('relay checks', () => {
  it('passes offers, answers and candidates', () => {
    expect(checkRelay(JSON.stringify({ type: 'offer', sdp: 'v=0' }))).toEqual({ ok: true });
    expect(checkRelay(JSON.stringify({ type: 'answer', sdp: 'v=0' }))).toEqual({ ok: true });
    expect(checkRelay(JSON.stringify({ type: 'candidate', candidate: { candidate: 'x' } }))).toEqual({ ok: true });
  });

  it('refuses binary, oversized, unparseable and unknown messages', () => {
    expect(checkRelay(new ArrayBuffer(8))).toMatchObject({ ok: false });
    expect(checkRelay('x'.repeat(LIMITS.messageBytes + 1))).toMatchObject({ ok: false, reason: 'too-large' });
    expect(checkRelay('{oops')).toMatchObject({ ok: false });
    expect(checkRelay(JSON.stringify({ type: 'chat', text: 'hi' }))).toMatchObject({ ok: false });
    expect(checkRelay(JSON.stringify(['offer']))).toMatchObject({ ok: false });
  });

  it('measures size in bytes, not characters', () => {
    const text = JSON.stringify({ type: 'offer', sdp: 'é'.repeat(LIMITS.messageBytes / 2) });
    expect(checkRelay(text)).toMatchObject({ ok: false, reason: 'too-large' });
  });
});

describe('rate limit', () => {
  it('allows a burst and refills over time', () => {
    let bucket: Bucket = { tokens: LIMITS.burst, at: 0 };
    for (let i = 0; i < LIMITS.burst; i++) {
      const next = takeToken(bucket, 0);
      expect(next.ok).toBe(true);
      bucket = next.bucket;
    }
    expect(takeToken(bucket, 0).ok).toBe(false);
    const later = takeToken(bucket, 1000);
    expect(later.ok).toBe(true);
    expect(bucket.tokens).toBeLessThan(1);
  });
});

describe('Room', () => {
  it('tells each side when the other arrives and relays between them', () => {
    const room = new Room(0);
    const host = peer();
    const guest = peer();
    expect(room.join('host', host, 0)).toEqual({ ok: true });
    expect(host.sent).toEqual([JSON.stringify({ type: 'room', peer: false })]);
    expect(room.join('guest', guest, 10)).toEqual({ ok: true });
    expect(guest.sent).toEqual([JSON.stringify({ type: 'room', peer: true })]);
    expect(host.sent[1]).toBe(JSON.stringify({ type: 'peer', joined: true }));

    const offer = JSON.stringify({ type: 'offer', sdp: 'v=0' });
    room.message('host', offer, 20);
    expect(guest.sent[1]).toBe(offer);
    const answer = JSON.stringify({ type: 'answer', sdp: 'v=0' });
    room.message('guest', answer, 30);
    expect(host.sent[2]).toBe(answer);
  });

  it('refuses a second host and a third peer', () => {
    const room = new Room(0);
    room.join('host', peer(), 0);
    expect(room.join('host', peer(), 1)).toMatchObject({ ok: false, status: 409 });
    room.join('guest', peer(), 2);
    expect(room.join('guest', peer(), 3)).toMatchObject({ ok: false, status: 409 });
    expect(room.size).toBe(2);
  });

  it('drops bad messages without relaying them and closes a peer that floods', () => {
    const room = new Room(0);
    const host = peer();
    const guest = peer();
    room.join('host', host, 0);
    room.join('guest', guest, 0);
    const before = guest.sent.length;
    room.message('host', JSON.stringify({ type: 'chat' }), 1);
    room.message('host', new ArrayBuffer(4), 1);
    expect(guest.sent.length).toBe(before);

    const candidate = JSON.stringify({ type: 'candidate', candidate: {} });
    for (let i = 0; i < LIMITS.burst + 5; i++) room.message('host', candidate, 2);
    expect(host.closed?.code).toBe(4008);
    expect(guest.sent.length).toBeLessThanOrEqual(before + LIMITS.burst);
  });

  it('holds a message for nobody: nothing is stored when the other side is absent', () => {
    const room = new Room(0);
    const host = peer();
    room.join('host', host, 0);
    room.message('host', JSON.stringify({ type: 'offer', sdp: 'v=0' }), 1);
    const guest = peer();
    room.join('guest', guest, 2);
    expect(guest.sent).toEqual([JSON.stringify({ type: 'room', peer: true })]);
  });

  it('tells the one who stays when the other leaves, and closes the room when the host goes', () => {
    const room = new Room(0);
    const host = peer();
    const guest = peer();
    room.join('host', host, 0);
    room.join('guest', guest, 0);
    room.leave('guest');
    expect(host.sent.at(-1)).toBe(JSON.stringify({ type: 'peer', joined: false }));
    expect(room.size).toBe(1);

    const again = peer();
    expect(room.join('guest', again, 5)).toEqual({ ok: true });
    room.leave('host');
    expect(again.closed?.code).toBe(4001);
    expect(room.size).toBe(0);
  });

  it('ignores a closed socket whose seat someone else has since taken', () => {
    const room = new Room(0);
    const host = peer();
    const first = peer();
    const second = peer();
    room.join('host', host, 0);
    room.join('guest', first, 0);
    room.leave('guest', first);
    room.join('guest', second, 10);
    // The first guest's close event arrives late.
    room.leave('guest', first);
    host.sent.length = 0;
    room.message('guest', JSON.stringify({ type: 'answer', sdp: 'v=0' }), 20);
    expect(host.sent).toHaveLength(1);

    const replacement = peer();
    room.leave('host', host);
    room.join('host', replacement, 30);
    room.leave('host', host);
    expect(room.size).toBe(1);
    expect(replacement.closed).toBeNull();
  });

  it('expires', () => {
    const room = new Room(1000);
    const host = peer();
    room.join('host', host, 1000);
    expect(room.expired(1000 + LIMITS.roomTtlMs - 1)).toBe(false);
    expect(room.expired(1000 + LIMITS.roomTtlMs)).toBe(true);
    expect(room.join('guest', peer(), 1000 + LIMITS.roomTtlMs)).toMatchObject({ ok: false, status: 410 });
    room.expire();
    expect(host.closed?.code).toBe(4000);
    expect(room.size).toBe(0);
  });
});
