import type { GameContext } from '../game/contracts';
import type { NetGameHooks, NetSystem } from './api';
import { NetSession } from './session';

export type { LobbyState, NetErrorCode, NetGameHooks, NetLobby, NetMatchConfig, NetMethod, NetNotice, NetRole, NetSnapshot, NetSystem } from './api';

/**
 * Two-player play over a direct connection.
 *
 * - `signaling`, `transport`, `invite`: getting the two machines connected,
 *   through a room code or codes passed by hand.
 * - `protocol`, `limits`: what is sent and what is accepted.
 * - `clock`, `interp`, `remote-soldier`: showing the other player (and a
 *   host's bots) smoothly, a little in the past.
 * - `match`: keeping one match in step. `session`: the lobby and lifecycle,
 *   and the `NetSystem` the game talks to.
 */
export function createNet(ctx: GameContext, hooks: NetGameHooks): NetSystem {
  return new NetSession(ctx, hooks);
}
