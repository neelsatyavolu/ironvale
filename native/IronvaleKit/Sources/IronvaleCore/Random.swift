// Ported from src/core/random.ts at commit cbe0add.

/// mulberry32, as `seededRandom` in src/core/random.ts: values in [0, 1).
public struct SeededRandom: Sendable {
    private var state: UInt32

    public init(seed: UInt32) {
        state = seed
    }

    public mutating func next() -> Double {
        state = state &+ 0x6D2B_79F5
        var t = state
        t = (t ^ (t >> 15)) &* (t | 1)
        t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
        return Double(t ^ (t >> 14)) / 4_294_967_296
    }
}

/// FNV-1a over UTF-16 code units, as `hashString` in src/core/random.ts.
public func hashString(_ text: String) -> UInt32 {
    var hash: UInt32 = 0x811C_9DC5
    for unit in text.utf16 {
        hash ^= UInt32(unit)
        hash = hash &* 0x0100_0193
    }
    return hash
}
