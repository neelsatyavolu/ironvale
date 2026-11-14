// Ported from src/fx/pool.ts at commit a487033.

/// Ring allocator: hands out slots in order and recycles the oldest once every slot is in use.
public struct RingPool: Sendable {
    public let capacity: Int
    private var cursor = 0
    private var used = 0

    public init(capacity: Int) {
        precondition(capacity >= 1, "RingPool needs a positive capacity, got \(capacity)")
        self.capacity = capacity
    }

    /// true once every slot has been handed out at least once.
    public var wrapped: Bool { used >= capacity }

    /// Take the next slot. When the pool is full this is the oldest one.
    public mutating func next() -> Int {
        let slot = cursor
        cursor = (cursor + 1) % capacity
        if used < capacity { used += 1 }
        return slot
    }

    /// The slot that will be handed out `ahead` allocations from now.
    public func peek(_ ahead: Int = 0) -> Int { (cursor + ahead) % capacity }

    public mutating func reset() {
        cursor = 0
        used = 0
    }
}

/// Tracks the span of slots written since the last upload.
public struct DirtyRange: Sendable {
    private var min = Int.max
    private var max = Int.min

    public init() {}

    public mutating func mark(_ slot: Int) {
        if slot < min { min = slot }
        if slot > max { max = slot }
    }

    /// The marked span (first slot, slot count), then clears; nil when nothing was marked.
    public mutating func take() -> (start: Int, count: Int)? {
        guard max >= min else { return nil }
        defer { min = .max; max = .min }
        return (min, max - min + 1)
    }
}

/// Particle count for a quality setting; the fractional part becomes a chance (`roll` in [0, 1)).
@inline(__always)
public func scaledCount(_ base: Double, _ density: Double, _ roll: Double) -> Int {
    let exact = base * Swift.max(0, density)
    let whole = exact.rounded(.down)
    return Int(whole) + (roll < exact - whole ? 1 : 0)
}
