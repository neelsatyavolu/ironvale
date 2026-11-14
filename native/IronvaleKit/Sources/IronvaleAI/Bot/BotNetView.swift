// What a co-op or duel host sends the guest about each bot (`BotView` in src/net/match.ts at commit
// cbe0add: `bot.watch === 'enemy'` shows as aiming, `bot.weaponDef.id` names the gun).
import IronvaleSim

extension Bot: NetBotView {
    public var watchingEnemy: Bool { watch == .enemy }
    public var weaponId: String { weaponDef.id }
    public var reloading: Bool { weapon.reloading }
}
