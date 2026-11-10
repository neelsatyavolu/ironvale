/**
 * Copy-and-paste connection codes: a WebRTC session description with its
 * gathered candidates, deflated and written in URL-safe base64. The host's
 * invite starts with `IVH1.`, the guest's reply with `IVG1.`, so pasting the
 * wrong one gets a clear answer.
 */

export type InviteKind = 'offer' | 'answer';
export type InviteError = 'empty' | 'malformed' | 'too-long' | 'wrong-kind';
export type InviteResult =
  | { readonly ok: true; readonly kind: InviteKind; readonly sdp: string }
  | { readonly ok: false; readonly reason: InviteError };

export const MAX_CODE_CHARS = 6000;
/** A data-only description with a dozen candidates is under 2 KB. */
const MAX_SDP_BYTES = 12_000;
const PREFIX: Readonly<Record<InviteKind, string>> = { offer: 'IVH1.', answer: 'IVG1.' };
const BODY = /^[A-Za-z0-9_-]+$/;
/** Printable ASCII and line breaks: what a session description is made of. */
const SDP_TEXT = /^[\x20-\x7e\r\n]*$/;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function readAll(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** Run `bytes` through a compression or decompression stream, giving up past `limit` bytes of output. */
async function pipe(bytes: Uint8Array<ArrayBuffer>, transform: GenericTransformStream, limit: number): Promise<Uint8Array | null> {
  const writer = (transform.writable as WritableStream<Uint8Array>).getWriter();
  // The write side fails when the data is not valid; the read side reports it too.
  const written = writer
    .write(bytes)
    .then(() => writer.close())
    .catch(() => undefined);
  try {
    return await readAll(transform.readable as ReadableStream<Uint8Array>, limit);
  } catch {
    return null;
  } finally {
    await written;
  }
}

export async function encodeInvite(kind: InviteKind, sdp: string): Promise<string> {
  const packed = await pipe(new TextEncoder().encode(sdp), new CompressionStream('deflate-raw'), Number.POSITIVE_INFINITY);
  if (!packed) throw new Error('Could not pack the connection code');
  return PREFIX[kind] + toBase64Url(packed);
}

/** Unpack a pasted code. `expected` is the kind this side is waiting for. */
export async function decodeInvite(text: string, expected: InviteKind): Promise<InviteResult> {
  if (typeof text !== 'string') return { ok: false, reason: 'malformed' };
  const code = text.replace(/\s+/g, '');
  if (code === '') return { ok: false, reason: 'empty' };
  if (code.length > MAX_CODE_CHARS) return { ok: false, reason: 'too-long' };
  const other: InviteKind = expected === 'offer' ? 'answer' : 'offer';
  if (code.startsWith(PREFIX[other])) return { ok: false, reason: 'wrong-kind' };
  if (!code.startsWith(PREFIX[expected])) return { ok: false, reason: 'malformed' };
  const body = code.slice(PREFIX[expected].length);
  if (!BODY.test(body)) return { ok: false, reason: 'malformed' };
  const packed = fromBase64Url(body);
  if (!packed) return { ok: false, reason: 'malformed' };
  const bytes = await pipe(packed, new DecompressionStream('deflate-raw'), MAX_SDP_BYTES);
  if (!bytes) return { ok: false, reason: 'malformed' };
  const sdp = new TextDecoder().decode(bytes);
  if (!sdp.startsWith('v=0') || !SDP_TEXT.test(sdp)) return { ok: false, reason: 'malformed' };
  return { ok: true, kind: expected, sdp };
}
