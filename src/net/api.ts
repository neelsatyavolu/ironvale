/**
 * What the rest of the game sees of two-player play: the lobby the interface
 * drives, the facts the match rules need, and the hooks the session calls
 * back into the game with.
 */
import type { BotSystem, MatchConfig, PlayerWeapons } from '../game/contracts';
import type { MapInstance, SpawnPoint } from '../world/types';
import type { NetMatchConfig } from './protocol';

export type { NetMatchConfig, NetMode, NetRules } from './protocol';

export type NetRole = 'host' | 'guest';
/** `room`: a six-character code through the signaling service. `manual`: codes copied and pasted by hand. */
export type NetMethod = 'room' | 'manual';

export type LobbyStep =
  /** Nothing in progress. */
  | 'idle'
  /** Opening a room, or gathering what goes into a code. */
  | 'opening'
  /** Host: a code is on screen and the friend has not arrived. */
  | 'waiting'
  /** Guest, copy-and-paste: a reply code is on screen for the host. */
  | 'reply'
  /** Both sides have what they need; the direct connection is being made. */
  | 'connecting'
  /** Connected to each other. */
  | 'connected';

export type NetErrorCode =
  | 'signal-unreachable'
  | 'no-room'
  | 'room-full'
  | 'room-expired'
  | 'rate-limited'
  | 'bad-code'
  | 'wrong-code-kind'
  | 'code-too-long'
  | 'connect-failed'
  | 'version'
  | 'unknown-map'
  | 'load-failed'
  | 'peer-left'
  | 'peer-timeout';

export type NetNotice =
  /** Waiting for the other player to finish loading. */
  | 'waiting-peer'
  | 'peer-away'
  | 'peer-left'
  | 'peer-timeout'
  /** Co-op guest: the host is gone and this player now runs the enemies. */
  | 'took-over';

export interface LobbyState {
  readonly step: LobbyStep;
  readonly role: NetRole | null;
  readonly method: NetMethod | null;
  /** The code to pass to the friend: a room code, an invite or a reply. Empty until there is one. */
  readonly code: string;
  readonly error: NetErrorCode | null;
  readonly localName: string;
  readonly peerName: string;
  /** Guest: pressed Ready. Host: always true. */
  readonly localReady: boolean;
  readonly peerReady: boolean;
  /** The host's choices. The guest sees a copy. */
  readonly config: NetMatchConfig;
  /** Round-trip time in milliseconds, or -1 when not known. */
  readonly rttMs: number;
  /** A match with the friend is loading or under way. */
  readonly inMatch: boolean;
}

/** The two-player part of a match snapshot, for the HUD and the end screen. */
export interface NetSnapshot {
  readonly role: NetRole;
  readonly localName: string;
  readonly peerName: string;
  /** The other player's kills: their score in a duel, their share in co-op. */
  readonly peerKills: number;
  readonly killTarget: number;
  readonly peerConnected: boolean;
  /** Whole seconds until the match starts; 0 once it has. */
  readonly countdown: number;
  readonly notice: NetNotice | null;
  readonly rttMs: number;
}

/** Commands the interface uses to set a two-player match up. */
export interface NetLobby {
  readonly state: LobbyState;
  subscribe(listener: (state: LobbyState) => void): () => void;
  /** true when a signaling service is configured and answering, so room codes can be offered. */
  roomCodesAvailable(): Promise<boolean>;
  host(method: NetMethod): void;
  /** `code` is a room code, or the host's invite for the copy-and-paste method. */
  join(method: NetMethod, code: string): void;
  /** Host, copy-and-paste: the reply code the guest sent back. */
  acceptReply(code: string): void;
  /** Host only. */
  setConfig(patch: Partial<NetMatchConfig>): void;
  /** Guest only. */
  setReady(ready: boolean): void;
  /** Host only; needs the guest to be ready. */
  start(): void;
  /** Close the connection. Safe to call at any time. */
  leave(): void;
  setName(name: string): void;
}

/** The other player, as the match rules need to know them. */
export interface NetPartner {
  readonly alive: boolean;
  readonly deaths: number;
}

/** What `Game` uses each frame and when loading. */
export interface NetSystem extends NetLobby {
  /** Connected to the other player with a match loading or under way. The simulation never pauses while this is true. */
  readonly inMatch: boolean;
  /** false only for a co-op guest whose host is connected: the host then decides waves and the result. */
  readonly authority: boolean;
  /** Nobody may move or shoot yet (waiting for the other player, or the countdown). */
  readonly frozen: boolean;
  /** The connected other player, or null. */
  readonly partner: NetPartner | null;
  /** Kills by the other player this match; kept after they leave. */
  readonly partnerKills: number;
  /** Co-op guest: the host's latest word on the match. */
  readonly hostMatch: { readonly wave: number; readonly enemies: number } | null;
  /** Null unless the loaded match began as a two-player match. */
  snapshot(): NetSnapshot | null;
  /** The map is built and the local player is registered: bring the other player in. */
  enterMap(map: MapInstance): void;
  /** The local player is placed and the match is ready to run. */
  matchLoaded(): void;
  leaveMap(): void;
  /** Where the local player should appear, or null for the game's own choice. */
  pickSpawn(map: MapInstance, initial: boolean): SpawnPoint | null;
  /** Co-op host: tell the guest how the match stands. */
  reportMatch(wave: number, enemies: number, result: '' | 'won' | 'lost', localKills: number): void;
  /** Every frame, in or out of a match. `running` is true while the match simulation is advancing. */
  update(dt: number, running: boolean): void;
  dispose(): void;
}

/** What the session needs the game to do. */
export interface NetGameHooks {
  readonly weapons: PlayerWeapons;
  readonly bots: BotSystem;
  listMaps(): readonly { id: string }[];
  startMatch(config: MatchConfig): Promise<void>;
  /** End the match now with this result (a duel whose opponent left; the host's verdict in co-op). */
  endMatch(result: 'won' | 'lost'): void;
  /** Co-op guest: the host started a new wave. */
  waveStarted(): void;
  /** Co-op guest: the host is gone. Put this many real enemies on the map and carry on alone. */
  takeOver(enemies: number, wave: number): void;
  /** Kills and deaths of the local player this match. */
  readonly kills: number;
  readonly deaths: number;
}

export const DEFAULT_NET_CONFIG: NetMatchConfig = {
  mapId: '',
  mode: 'coop',
  rules: 'skirmish',
  difficulty: 'regular',
  botCount: 8,
  killTarget: 10,
};
