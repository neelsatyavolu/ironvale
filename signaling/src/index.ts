/**
 * Ironvale signaling relay.
 *
 * Two players who want a peer-to-peer match each open a WebSocket to
 * `/room/<code>?role=host|guest`. One Durable Object per code passes their
 * WebRTC offer, answer and candidates across. Nothing is stored, a room holds
 * two sockets at most and closes ten minutes after it opened. Once the
 * players are connected to each other they close their sockets.
 */
import { DurableObject } from 'cloudflare:workers';
import { CLOSE, Room, isRole, isRoomCode, originAllowed, parseAllowedOrigins, type Role } from './room';

/** Close codes for a join that was refused, so the page can say why (a browser cannot read the HTTP status). */
const REFUSED_BASE = 4000;

function json(body: object, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowed = originAllowed(origin, parseAllowedOrigins(env.ALLOWED_ORIGINS));

    if (url.pathname === '/health') {
      // The game asks this before offering room codes. Only listed origins may read the answer.
      const cors: Record<string, string> = allowed && origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
      return json({ ok: true }, 200, cors);
    }

    const match = /^\/room\/([^/]+)$/.exec(url.pathname);
    if (!match) return json({ error: 'Not found' }, 404);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'Expected a WebSocket' }, 426);
    if (!allowed) return json({ error: 'Origin not allowed' }, 403);
    const code = match[1] ?? '';
    if (!isRoomCode(code) || !isRole(url.searchParams.get('role'))) return json({ error: 'Bad room code or role' }, 400);

    const address = request.headers.get('CF-Connecting-IP') ?? 'local';
    const { success } = await env.JOIN_LIMITER.limit({ key: address });
    if (!success) return json({ error: 'Too many attempts. Wait a minute and try again.' }, 429);

    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class RoomObject extends DurableObject<Env> {
  private readonly room = new Room(Date.now());

  override async fetch(request: Request): Promise<Response> {
    const role = new URL(request.url).searchParams.get('role');
    if (!isRole(role)) return json({ error: 'Bad role' }, 400);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const now = Date.now();
    const admission = this.room.join(role, server, now);
    if (!admission.ok) {
      // Accept, then close with the reason: the only way a browser gets to see it.
      server.close(REFUSED_BASE + admission.status, admission.error);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (role === 'host') await this.ctx.storage.setAlarm(now + this.room.timeLeft(now));
    this.listen(role, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async alarm(): Promise<void> {
    this.room.expire();
  }

  private listen(role: Role, socket: WebSocket): void {
    socket.addEventListener('message', (event) => {
      this.room.message(role, event.data as string | ArrayBuffer, Date.now());
    });
    const gone = (): void => {
      this.room.leave(role, socket);
      if (this.room.size === 0) void this.ctx.storage.deleteAlarm().catch(() => undefined);
    };
    socket.addEventListener('close', (event) => {
      gone();
      try {
        // Complete the closing handshake unless this side started it.
        if (event.code !== CLOSE.expired && event.code !== CLOSE.hostLeft && event.code !== CLOSE.flooding) socket.close(1000, 'Bye');
      } catch {
        // Already closed.
      }
    });
    socket.addEventListener('error', gone);
  }
}
