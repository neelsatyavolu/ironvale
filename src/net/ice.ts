/** STUN servers used to find a route between the two players. Both are free and need no account. */
const STUN: RTCIceServer = { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] };
const SCHEME = /^(stun|turn|turns):/;
const MAX_EXTRA_SERVERS = 6;

function validUrls(urls: unknown): string[] | null {
  const list = typeof urls === 'string' ? [urls] : Array.isArray(urls) ? urls : null;
  if (!list || list.length === 0 || list.length > 8) return null;
  return list.every((url): url is string => typeof url === 'string' && url.length < 200 && SCHEME.test(url)) ? list : null;
}

/**
 * Extra servers (usually TURN, for players behind strict routers) from the
 * `VITE_ICE_SERVERS` build setting: a JSON array of
 * `{ "urls": "turn:...", "username": "...", "credential": "..." }`.
 * Entries that do not look like ICE servers are left out.
 */
export function parseIceServers(raw: string | undefined): RTCIceServer[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    console.warn('VITE_ICE_SERVERS is not valid JSON; using STUN only');
    return [];
  }
  if (!Array.isArray(data)) return [];
  const servers: RTCIceServer[] = [];
  for (const entry of data.slice(0, MAX_EXTRA_SERVERS)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const fields = entry as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = validUrls(fields.urls);
    if (!urls) continue;
    servers.push({
      urls,
      ...(typeof fields.username === 'string' ? { username: fields.username } : {}),
      ...(typeof fields.credential === 'string' ? { credential: fields.credential } : {}),
    });
  }
  return servers;
}

export function iceServers(extra: string | undefined = import.meta.env.VITE_ICE_SERVERS as string | undefined): RTCIceServer[] {
  return [STUN, ...parseIceServers(extra)];
}

const RELAY_TIMEOUT_MS = 3000;

/**
 * Short-lived relay (TURN) servers from the signaling service, for players
 * whose networks block direct connections. Empty when there is no service or
 * it does not answer: the game then tries a direct connection only.
 */
export async function fetchRelayServers(baseUrl: string): Promise<RTCIceServer[]> {
  if (!baseUrl) return [];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), RELAY_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl.replace(/^ws/, 'http')}/ice`, { signal: abort.signal, cache: 'no-store' });
    if (!response.ok) return [];
    const body = (await response.json()) as { iceServers?: unknown };
    return parseIceServers(JSON.stringify(body.iceServers ?? []));
  } catch (error) {
    console.warn('Could not get relay servers; trying a direct connection only', error);
    return [];
  } finally {
    clearTimeout(timer);
  }
}
