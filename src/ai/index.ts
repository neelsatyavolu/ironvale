import type { BotSystem, GameContext } from '../game/contracts';
import { BotManager } from './manager';

/**
 * Enemy soldiers.
 *
 * - Navigation: a walkable grid sampled from the collision world when a map
 *   loads (`navgrid`), A* with a per-frame budget (`pathfinder`) and
 *   precomputed cover (`cover`).
 * - A bot is a walking capsule (`body`) that aims and shoots (`bot`,
 *   `botweapon`, `aim`), driven six to eight times a second by a small state
 *   machine (`brain` for senses and calm states, `tactics*` for the fight).
 * - The squad shares a blackboard (`blackboard`); difficulty and roles are
 *   data (`difficulty`, `roles`); `manager` owns it all and is the
 *   `BotSystem` the game talks to.
 *
 * `?botdebug` draws each bot's path and state and logs state changes;
 * `?botdebug=cover` and `?botdebug=nav` also show cover cells or every
 * walkable cell. `game.bots.stats` has timings.
 */
export function createBots(ctx: GameContext): BotSystem {
  return new BotManager(ctx);
}
