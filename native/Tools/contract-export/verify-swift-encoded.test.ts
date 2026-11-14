/**
 * Reverse codec check (PLAN.md 5.4 layer 2). IronvaleWireTests writes everything Swift encodes to
 * native/Contract/out/swift-encoded.json; this decodes it with the real web modules and requires
 * the inputs back, byte-identical encodings, and identical sanitiser output. Run by
 * native/ci/check-m1.sh after `swift test`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeInvite, MAX_CODE_CHARS, type InviteKind } from '../../../src/net/invite';
import { sanitizeChat, sanitizeName } from '../../../src/net/limits';
import { decodeBinary, encodeEvent, parseEvent, type NetEvent } from '../../../src/net/protocol';
import { inviteLink, isRoomCode } from '../../../src/net/room-code';
import { encodeBinary } from './fixtures';

const here = dirname(fileURLToPath(import.meta.url));
const path = resolve(here, '../../Contract/out/swift-encoded.json');

interface SwiftEncoded {
  binary: { kind: string; input: unknown; hex: string }[];
  events: { event: NetEvent; text: string }[];
  sanitize: { kind: 'name' | 'chat'; input: string; out: string }[];
  invites: { kind: InviteKind; sdp: string; code: string }[];
  roomCodes: string[];
  inviteLinks: { code: string; page: string; out: string }[];
}

function load(): SwiftEncoded {
  if (!existsSync(path)) throw new Error(`${path} is missing: run swift test (IronvaleWireTests) first`);
  return JSON.parse(readFileSync(path, 'utf8')) as SwiftEncoded;
}

const toBuffer = (hex: string): ArrayBuffer => {
  const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

describe('Swift-encoded messages decode in TypeScript', () => {
  const data = load();

  it('binary: same bytes as the TS encoder, and decodes to the same message', () => {
    expect(data.binary.length).toBeGreaterThan(400);
    for (const entry of data.binary) {
      const ts = Buffer.from(encodeBinary({ kind: entry.kind, input: entry.input } as Parameters<typeof encodeBinary>[0])).toString('hex');
      expect(entry.hex, `${entry.kind} ${JSON.stringify(entry.input)}`).toBe(ts);
      const decoded = decodeBinary(toBuffer(entry.hex));
      expect(decoded, entry.hex).not.toBeNull();
      expect(decoded).toEqual(decodeBinary(toBuffer(ts)));
    }
  });

  it('events: the TS validator accepts every one and reads back the same event', () => {
    expect(data.events.length).toBeGreaterThan(1000);
    for (const entry of data.events) {
      expect(entry.text, 'Swift text equals JSON.stringify of the same event').toBe(encodeEvent(entry.event));
      expect(parseEvent(entry.text), entry.text).toEqual(entry.event);
    }
  });

  it('sanitisers: Swift output equals TS output', () => {
    expect(data.sanitize.length).toBeGreaterThan(1000);
    for (const entry of data.sanitize) {
      const ts = entry.kind === 'name' ? sanitizeName(entry.input) : sanitizeChat(entry.input);
      expect(entry.out, `${entry.kind} ${JSON.stringify(entry.input)}`).toBe(ts.toWellFormed());
    }
  });

  it('invite codes: Swift deflate unpacks in the web codec', async () => {
    expect(data.invites.length).toBeGreaterThan(20);
    for (const entry of data.invites) {
      expect(entry.code.length).toBeLessThan(MAX_CODE_CHARS);
      expect(await decodeInvite(entry.code, entry.kind)).toEqual({ ok: true, kind: entry.kind, sdp: entry.sdp });
    }
  });

  it('room codes and invite links are what the web makes', () => {
    expect(data.roomCodes.length).toBeGreaterThan(100);
    for (const code of data.roomCodes) expect(isRoomCode(code), code).toBe(true);
    for (const entry of data.inviteLinks) expect(entry.out).toBe(inviteLink(entry.code, entry.page));
  });
});
