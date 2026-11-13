import { describe, expect, it, vi } from 'vitest';
import type { GameContext } from '../../src/game/contracts';
import type { NetGameHooks } from '../../src/net/api';
import { PROTOCOL_VERSION, encodeEvent, type NetEvent, type NetMatchConfig } from '../../src/net/protocol';
import { NetSession } from '../../src/net/session';

const CONFIG: NetMatchConfig = { mapId: 'harbor', mode: 'duel', rules: 'skirmish', difficulty: 'regular', botCount: 4, killTarget: 5, duelBot: 'none' };

interface Internals {
  lobby: object;
  link: object | null;
  goAt: number;
  onEvent(text: string): void;
}

/** A guest that is connected to a host, with the connection replaced by a recorder. */
function connectedGuest() {
  const hooks = {
    listMaps: () => [{ id: 'harbor', name: 'Harbor', tagline: '' }],
    startMatch: vi.fn(() => new Promise<void>(() => undefined)),
    endMatch: vi.fn(),
    takeOver: vi.fn(),
    waveStarted: vi.fn(),
    kills: 0,
    deaths: 0,
  };
  const ctx = { settings: { value: { gameplay: { difficulty: 'regular' } } } } as unknown as GameContext;
  const session = new NetSession(ctx, hooks as unknown as NetGameHooks);
  const inner = session as unknown as Internals;
  const sent: string[] = [];
  inner.lobby = { ...session.state, step: 'connected', role: 'guest', method: 'manual' };
  inner.link = { open: true, sendEvent: (data: string) => sent.push(data) > 0, sendState: () => undefined, close: () => undefined };
  const receive = (event: NetEvent): void => inner.onEvent(encodeEvent(event));
  return { session, inner, hooks, receive };
}

describe('a guest and a host that does not follow the rules', () => {
  it('loads a match only after saying it is ready, and once', () => {
    const { session, hooks, receive } = connectedGuest();
    receive({ t: 'load', config: CONFIG });
    expect(hooks.startMatch).not.toHaveBeenCalled();
    session.setReady(true);
    receive({ t: 'load', config: CONFIG });
    receive({ t: 'load', config: CONFIG });
    expect(hooks.startMatch).toHaveBeenCalledTimes(1);
  });

  it('takes the start time once: a second one cannot freeze the match again', () => {
    const { session, inner, receive } = connectedGuest();
    session.setReady(true);
    receive({ t: 'load', config: CONFIG });
    receive({ t: 'go', at: performance.now() });
    const first = inner.goAt;
    expect(Number.isFinite(first)).toBe(true);
    receive({ t: 'go', at: performance.now() + 8000 });
    expect(inner.goAt).toBe(first);
  });

  it('ends a running duel when the connection is dropped for a protocol error', () => {
    const { session, hooks, receive } = connectedGuest();
    session.setReady(true);
    receive({ t: 'load', config: CONFIG });
    session.matchLoaded();
    expect(session.inMatch).toBe(true);
    receive({ t: 'hello', v: PROTOCOL_VERSION + 1, name: 'Mallory' });
    expect(session.state.error).toBe('version');
    expect(session.snapshot()?.peerConnected).toBe(false);
    expect(hooks.endMatch).toHaveBeenCalledTimes(1);
  });
});

describe('a duel with a bot', () => {
  it('leaves the bot to the host: the guest runs none, whoever it fights for', () => {
    const { session, hooks, receive } = connectedGuest();
    session.setReady(true);
    receive({ t: 'load', config: { ...CONFIG, duelBot: 'guest', difficulty: 'elite' } });
    expect(hooks.startMatch).toHaveBeenCalledWith(expect.objectContaining({ mode: 'duel', botCount: 0, difficulty: 'elite' }));
  });
});
