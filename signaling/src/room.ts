/**
 * Room logic for the signaling relay, kept free of Workers types so it can be
 * unit tested: who may join, what may be relayed, how fast, and when a room
 * ends. A room holds two sockets at most and stores nothing: a message for an
 * absent peer is dropped.
 */

export type Role = 'host' | 'guest';

export const LIMITS = {
  /** Largest message relayed. A session description with candidates is 1 - 3 KB. */
  messageBytes: 16_384,
  /** Messages a socket may send at once, and how fast the allowance refills. */
  burst: 40,
  perSecond: 4,
  /** A room closes this long after it was opened, connected or not. */
  roomTtlMs: 10 * 60_000,
} as const;

export const CLOSE = {
  expired: 4000,
  hostLeft: 4001,
  flooding: 4008,
} as const;

const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const RELAYED_TYPES: readonly string[] = ['offer', 'answer', 'candidate'];

export function isRoomCode(code: string): boolean {
  return CODE.test(code);
}

export function isRole(value: string | null): value is Role {
  return value === 'host' || value === 'guest';
}

export type Admission = { readonly ok: true } | { readonly ok: false; readonly status: number; readonly error: string };

/** Decide whether a socket asking for `role` may join a room that holds `present`. */
export function admit(present: readonly Role[], role: Role): Admission {
  if (role === 'host') {
    return present.includes('host') ? { ok: false, status: 409, error: 'That code is already in use.' } : { ok: true };
  }
  if (!present.includes('host')) return { ok: false, status: 404, error: 'No game is waiting under that code.' };
  if (present.includes('guest')) return { ok: false, status: 409, error: 'That game already has two players.' };
  return { ok: true };
}

export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
}

/** Exact match against the configured list. A request with no Origin header is refused. */
export function originAllowed(origin: string | null, allowed: readonly string[]): boolean {
  return origin !== null && allowed.includes(origin);
}

export type RelayCheck = { readonly ok: true } | { readonly ok: false; readonly reason: 'binary' | 'too-large' | 'not-json' | 'unknown-type' };

const encoder = new TextEncoder();

/** Only JSON objects of a known type, within the size limit, are passed on. The content is not inspected further. */
export function checkRelay(data: string | ArrayBuffer): RelayCheck {
  if (typeof data !== 'string') return { ok: false, reason: 'binary' };
  // Three bytes per UTF-16 unit is the worst case; only measure exactly when it could matter.
  if (data.length > LIMITS.messageBytes || (data.length * 3 > LIMITS.messageBytes && encoder.encode(data).byteLength > LIMITS.messageBytes)) {
    return { ok: false, reason: 'too-large' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { ok: false, reason: 'not-json' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, reason: 'unknown-type' };
  const type = (parsed as { type?: unknown }).type;
  return typeof type === 'string' && RELAYED_TYPES.includes(type) ? { ok: true } : { ok: false, reason: 'unknown-type' };
}

export interface Bucket {
  readonly tokens: number;
  /** Millisecond time of the last refill. */
  readonly at: number;
}

export function takeToken(bucket: Bucket, now: number): { readonly ok: boolean; readonly bucket: Bucket } {
  const elapsed = Math.max(0, now - bucket.at);
  const tokens = Math.min(LIMITS.burst, bucket.tokens + (elapsed / 1000) * LIMITS.perSecond);
  if (tokens < 1) return { ok: false, bucket: { tokens, at: now } };
  return { ok: true, bucket: { tokens: tokens - 1, at: now } };
}

/** The part of a WebSocket the room uses. */
export interface Peer {
  send(text: string): void;
  close(code: number, reason: string): void;
}

interface Seat {
  readonly peer: Peer;
  bucket: Bucket;
}

/** One game's relay: a host seat and a guest seat. */
export class Room {
  private readonly seats = new Map<Role, Seat>();

  constructor(private createdAt: number) {}

  get size(): number {
    return this.seats.size;
  }

  expired(now: number): boolean {
    return now - this.createdAt >= LIMITS.roomTtlMs;
  }

  /** Milliseconds until the room should be closed. */
  timeLeft(now: number): number {
    return Math.max(0, this.createdAt + LIMITS.roomTtlMs - now);
  }

  join(role: Role, peer: Peer, now: number): Admission {
    // An empty room is a new game: its lifetime starts when the host arrives.
    if (this.seats.size === 0) this.createdAt = now;
    else if (this.expired(now)) return { ok: false, status: 410, error: 'That code has expired. Ask your friend for a new one.' };
    const admission = admit([...this.seats.keys()], role);
    if (!admission.ok) return admission;
    this.seats.set(role, { peer, bucket: { tokens: LIMITS.burst, at: now } });
    const other = this.seats.get(role === 'host' ? 'guest' : 'host');
    safeSend(peer, { type: 'room', peer: other !== undefined });
    if (other) safeSend(other.peer, { type: 'peer', joined: true });
    return { ok: true };
  }

  message(from: Role, data: string | ArrayBuffer, now: number): void {
    const seat = this.seats.get(from);
    if (!seat) return;
    const taken = takeToken(seat.bucket, now);
    seat.bucket = taken.bucket;
    if (!taken.ok) {
      safeClose(seat.peer, CLOSE.flooding, 'Too many messages');
      this.leave(from);
      return;
    }
    if (!checkRelay(data).ok || typeof data !== 'string') return;
    const other = this.seats.get(from === 'host' ? 'guest' : 'host');
    if (!other) return;
    try {
      other.peer.send(data);
    } catch {
      // The other socket is closing; its own close event tidies up.
    }
  }

  /** `peer`: the socket that closed. A late close from a socket whose seat has been taken again changes nothing. */
  leave(role: Role, peer?: Peer): void {
    if (peer && this.seats.get(role)?.peer !== peer) return;
    if (!this.seats.delete(role)) return;
    if (role === 'host') {
      // Without a host there is no game to join: free the code.
      const guest = this.seats.get('guest');
      if (guest) safeClose(guest.peer, CLOSE.hostLeft, 'The host left');
      this.seats.clear();
      return;
    }
    const host = this.seats.get('host');
    if (host) safeSend(host.peer, { type: 'peer', joined: false });
  }

  expire(): void {
    for (const seat of this.seats.values()) safeClose(seat.peer, CLOSE.expired, 'The code expired');
    this.seats.clear();
  }
}

function safeSend(peer: Peer, message: object): void {
  try {
    peer.send(JSON.stringify(message));
  } catch {
    // A socket that is already closing cannot be told anything.
  }
}

function safeClose(peer: Peer, code: number, reason: string): void {
  try {
    peer.close(code, reason);
  } catch {
    // Already closed.
  }
}
