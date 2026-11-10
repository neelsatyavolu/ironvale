import { describe, expect, it } from 'vitest';
import { seededRandom } from '../../src/core/random';
import { MAX_CODE_CHARS, decodeInvite, encodeInvite } from '../../src/net/invite';

const SDP = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 54321 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 203.0.113.7',
  'a=candidate:1 1 udp 2113937151 0d8e7a1c-1c1f-4a0b-b1b4-2f8c9d6a4e11.local 54321 typ host generation 0 network-cost 999',
  'a=candidate:2 1 udp 1677729535 203.0.113.7 54321 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999',
  'a=ice-ufrag:4ZcD',
  'a=ice-pwd:2/1muCWoOi3uLifh0NuRHlQ1',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n');

describe('invite codes', () => {
  it('round trips an offer and an answer', async () => {
    const offer = await encodeInvite('offer', SDP);
    expect(await decodeInvite(offer, 'offer')).toEqual({ ok: true, kind: 'offer', sdp: SDP });
    const answer = await encodeInvite('answer', SDP);
    expect(await decodeInvite(answer, 'answer')).toEqual({ ok: true, kind: 'answer', sdp: SDP });
  });

  it('is safe to paste anywhere: only URL-safe characters, and shorter than the session text', async () => {
    const code = await encodeInvite('offer', SDP);
    expect(code).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(code.length).toBeLessThan(SDP.length);
  });

  it('survives the line breaks and spaces a messenger adds', async () => {
    const code = await encodeInvite('offer', SDP);
    const wrapped = `  ${code.slice(0, 40)}\n${code.slice(40, 90)} \r\n${code.slice(90)}\n`;
    expect(await decodeInvite(wrapped, 'offer')).toMatchObject({ ok: true });
  });

  it('says so when the wrong kind of code is pasted', async () => {
    const offer = await encodeInvite('offer', SDP);
    expect(await decodeInvite(offer, 'answer')).toEqual({ ok: false, reason: 'wrong-kind' });
  });

  it('rejects an empty box, a random sentence, a room code and a cut-off code', async () => {
    const code = await encodeInvite('offer', SDP);
    expect(await decodeInvite('   ', 'offer')).toEqual({ ok: false, reason: 'empty' });
    expect(await decodeInvite('see you at eight', 'offer')).toEqual({ ok: false, reason: 'malformed' });
    expect(await decodeInvite('K7M2QX', 'offer')).toEqual({ ok: false, reason: 'malformed' });
    expect(await decodeInvite(code.slice(0, code.length - 25), 'offer')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a code that is too long without unpacking it', async () => {
    const long = `IVH1.${'A'.repeat(MAX_CODE_CHARS)}`;
    expect(await decodeInvite(long, 'offer')).toEqual({ ok: false, reason: 'too-long' });
  });

  it('rejects contents that are not a session description', async () => {
    const notSdp = await encodeInvite('offer', 'v=0\r\n<script>alert(1)</script>\u0007\r\n');
    expect(await decodeInvite(notSdp, 'offer')).toEqual({ ok: false, reason: 'malformed' });
    const noHeader = await encodeInvite('offer', 'hello there');
    expect(await decodeInvite(noHeader, 'offer')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a small code that unpacks to something huge', async () => {
    const bomb = await encodeInvite('offer', `v=0\r\n${'a=x\r\n'.repeat(40_000)}`);
    expect(bomb.length).toBeLessThan(MAX_CODE_CHARS);
    expect(await decodeInvite(bomb, 'offer')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('never throws on fuzzed text', async () => {
    const random = seededRandom(11);
    const alphabet = 'IVHG1.ABCabc012-_=+/ \n{}<>';
    for (let i = 0; i < 300; i++) {
      let text = random() < 0.5 ? 'IVH1.' : '';
      const length = Math.floor(random() * 200);
      for (let j = 0; j < length; j++) text += alphabet[Math.floor(random() * alphabet.length)];
      const result = await decodeInvite(text, 'offer');
      expect(result.ok).toBe(false);
    }
  });
});
