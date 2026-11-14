// The parts of a host's bot that are sent to the guest (`BotView` in src/net/match.ts at commit
// cbe0add; src/ai/bot.ts has them all). IronvaleAI's bots conform so IronvaleNet can send them.
public protocol NetBotView: Combatant {
    var yaw: Double { get }
    var pitch: Double { get }
    var speed: Double { get }
    /// `bot.watch === 'enemy'`: shown aiming.
    var watchingEnemy: Bool { get }
    var weaponId: String { get }
    var reloading: Bool { get }
}
