import type { Combatant, GameContext } from '../game/contracts';
import type { BotState, CalloutKind, Squad } from './blackboard';
import type { Bot } from './bot';
import type { NavGrid } from './navgrid';
import type { PathQueue } from './pathfinder';

/** What the brain, the body and the manager share. */
export interface BotEnv {
  readonly ctx: GameContext;
  readonly grid: NavGrid;
  readonly paths: PathQueue;
  readonly squad: Squad;
  readonly bots: readonly Bot[];
  readonly random: () => number;
  /** Seconds since the map was entered. */
  readonly time: number;
  readonly fogDensity: number;
  /** Living enemies of the bots, refreshed a few times a second. */
  readonly enemies: readonly Combatant[];
  /** 0 - 1: how far this bot's patrol has drifted toward the player after a long quiet spell. */
  sweepBias(bot: Bot): number;
  callout(bot: Bot, kind: CalloutKind): void;
  /** Debug hook; called on every state change. */
  transition(bot: Bot, from: BotState, to: BotState, reason: string): void;
}
