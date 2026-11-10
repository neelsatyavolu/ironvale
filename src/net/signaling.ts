/**
 * Signaling: how the two players exchange the few messages WebRTC needs
 * before it can connect them directly. One interface, two ways of doing it:
 *
 * - `RoomSignaling`: both open a WebSocket to the relay under a six-character
 *   room code (see `signaling/` in the repository).
 * - `ManualSignaling`: no server. The host's offer becomes an invite code the
 *   players pass by any messenger, and the guest's answer comes back the same way.
 */
import type { NetErrorCode, NetRole } from './api';
import { decodeInvite, encodeInvite, type InviteError } from './invite';
import { isRoomCode, makeRoomCode, normalizeRoomCode } from './room-code';

export type SignalMessage =
  | { readonly type: 'offer'; readonly sdp: string }
  | { readonly type: 'answer'; readonly sdp: string }
  | { readonly type: 'candidate'; readonly candidate: RTCIceCandidateInit };

export interface SignalHandlers {
  /** A code for the player to pass on: the room code, the invite, or the reply. */
  onCode(code: string): void;
  /** The other side is there (or has gone). The host makes its offer when this turns true. */
  onPeer(present: boolean): void;
  onSignal(message: SignalMessage): void;
  onError(error: NetErrorCode): void;
}

export interface Signaling {
  /** true: candidates travel one by one. false: each side sends a single description carrying them all. */
  readonly trickle: boolean;
  /** `code`: for a guest, the room code or the pasted invite. Ignored for a host. */
  open(role: NetRole, code: string, handlers: SignalHandlers): void;
  send(message: SignalMessage): void;
  /** Copy-and-paste only: the host pastes the guest's reply here. */
  paste(text: string): void;
  /** Stop. No handler is called after this. */
  close(): void;
}

const MAX_SDP_CHARS = 12_000;
const MAX_CANDIDATE_CHARS = 1000;
const HEALTH_TIMEOUT_MS = 2500;
const HOST_CODE_ATTEMPTS = 4;

/** Check a relayed message before it reaches the peer connection. */
export function parseSignal(text: unknown): SignalMessage | { readonly type: 'room'; readonly peer: boolean } | { readonly type: 'peer'; readonly joined: boolean } | null {
  if (typeof text !== 'string' || text.length > MAX_SDP_CHARS + 200) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const fields = data as Record<string, unknown>;
  switch (fields.type) {
    case 'offer':
    case 'answer':
      return typeof fields.sdp === 'string' && fields.sdp.length <= MAX_SDP_CHARS ? { type: fields.type, sdp: fields.sdp } : null;
    case 'candidate': {
      const candidate = fields.candidate;
      if (typeof candidate !== 'object' || candidate === null) return null;
      const init = candidate as Record<string, unknown>;
      if (typeof init.candidate !== 'string' || init.candidate.length > MAX_CANDIDATE_CHARS) return null;
      return {
        type: 'candidate',
        candidate: {
          candidate: init.candidate,
          sdpMid: typeof init.sdpMid === 'string' ? init.sdpMid.slice(0, 32) : null,
          sdpMLineIndex: typeof init.sdpMLineIndex === 'number' && Number.isInteger(init.sdpMLineIndex) ? init.sdpMLineIndex : null,
          usernameFragment: typeof init.usernameFragment === 'string' ? init.usernameFragment.slice(0, 256) : null,
        },
      };
    }
    case 'room':
      return typeof fields.peer === 'boolean' ? { type: 'room', peer: fields.peer } : null;
    case 'peer':
      return typeof fields.joined === 'boolean' ? { type: 'peer', joined: fields.joined } : null;
    default:
      return null;
  }
}

/** The relay's base URL, from the build setting or (development only) `?signal=` in the address. */
export function signalUrl(): string {
  const configured = (import.meta.env.VITE_SIGNAL_URL as string | undefined) ?? '';
  const override = import.meta.env.DEV && typeof location !== 'undefined' ? new URLSearchParams(location.search).get('signal') : null;
  const url = (override ?? configured).trim().replace(/\/+$/, '');
  return /^(wss?|https?):\/\//.test(url) ? url : '';
}

function toHttp(url: string): string {
  return url.replace(/^ws/, 'http');
}

function toWs(url: string): string {
  return url.replace(/^http/, 'ws');
}

/** true when the relay answers its health check within a couple of seconds. */
export async function signalReachable(url: string): Promise<boolean> {
  if (!url) return false;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${toHttp(url)}/health`, { signal: abort.signal, cache: 'no-store' });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Why the relay closed the socket, as an error the interface can explain. Null when it is not an error. */
function closeError(code: number, role: NetRole, opened: boolean): NetErrorCode | null {
  switch (code) {
    case 4404:
      return 'no-room';
    case 4409:
      return 'room-full';
    case 4410:
    case 4000:
      return 'room-expired';
    case 4001:
      return 'peer-left';
    case 4008:
    case 4429:
      return 'rate-limited';
    case 1000:
      return null;
    default:
      return opened ? (role === 'guest' ? 'peer-left' : 'signal-unreachable') : 'signal-unreachable';
  }
}

export class RoomSignaling implements Signaling {
  readonly trickle = true;
  private socket: WebSocket | null = null;
  private handlers: SignalHandlers | null = null;
  private attempts = 0;

  constructor(private readonly baseUrl: string) {}

  open(role: NetRole, code: string, handlers: SignalHandlers): void {
    this.handlers = handlers;
    if (role === 'host') {
      this.connect(role, makeRoomCode());
      return;
    }
    const tidy = normalizeRoomCode(code);
    if (!isRoomCode(tidy)) {
      this.fail('bad-code');
      return;
    }
    this.connect(role, tidy);
  }

  send(message: SignalMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      console.warn('Could not send through the room', error);
    }
  }

  paste(): void {
    // Room codes need nothing pasted back.
  }

  close(): void {
    this.handlers = null;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(1000);
    } catch {
      // Already closed.
    }
  }

  private fail(error: NetErrorCode): void {
    const handlers = this.handlers;
    this.close();
    handlers?.onError(error);
  }

  private connect(role: NetRole, code: string): void {
    let socket: WebSocket;
    try {
      socket = new WebSocket(`${toWs(this.baseUrl)}/room/${code}?role=${role}`);
    } catch {
      this.fail('signal-unreachable');
      return;
    }
    this.socket = socket;
    let opened = false;
    socket.addEventListener('open', () => {
      opened = true;
    });
    socket.addEventListener('message', (event: MessageEvent) => {
      if (this.socket !== socket) return;
      const message = parseSignal(event.data);
      if (!message) return;
      if (message.type === 'room') {
        // The relay let us in. A host now has a code to share; a guest knows the host is there.
        if (role === 'host') this.handlers?.onCode(code);
        else this.handlers?.onPeer(message.peer);
      } else if (message.type === 'peer') this.handlers?.onPeer(message.joined);
      else this.handlers?.onSignal(message);
    });
    socket.addEventListener('close', (event: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      // Another game holds this code: pick a new one.
      if (role === 'host' && event.code === 4409 && ++this.attempts < HOST_CODE_ATTEMPTS) {
        this.connect(role, makeRoomCode());
        return;
      }
      const error = closeError(event.code, role, opened);
      if (error) this.fail(error);
    });
  }
}

const INVITE_ERRORS: Readonly<Record<InviteError, NetErrorCode>> = {
  empty: 'bad-code',
  malformed: 'bad-code',
  'too-long': 'code-too-long',
  'wrong-kind': 'wrong-code-kind',
};

export class ManualSignaling implements Signaling {
  readonly trickle = false;
  private handlers: SignalHandlers | null = null;
  private role: NetRole = 'host';

  open(role: NetRole, code: string, handlers: SignalHandlers): void {
    this.handlers = handlers;
    this.role = role;
    if (role === 'host') {
      // Nobody to wait for: the offer itself is the invite.
      handlers.onPeer(true);
      return;
    }
    void this.read(code, 'offer');
  }

  send(message: SignalMessage): void {
    if (message.type === 'candidate') return;
    encodeInvite(message.type, message.sdp).then(
      (code) => this.handlers?.onCode(code),
      (error: unknown) => {
        console.error('Could not make the connection code', error);
        this.handlers?.onError('connect-failed');
      },
    );
  }

  paste(text: string): void {
    if (this.role === 'host') void this.read(text, 'answer');
  }

  close(): void {
    this.handlers = null;
  }

  private async read(text: string, kind: 'offer' | 'answer'): Promise<void> {
    const result = await decodeInvite(text, kind).catch(() => ({ ok: false, reason: 'malformed' }) as const);
    if (result.ok) this.handlers?.onSignal({ type: result.kind, sdp: result.sdp });
    else this.handlers?.onError(INVITE_ERRORS[result.reason]);
  }
}
