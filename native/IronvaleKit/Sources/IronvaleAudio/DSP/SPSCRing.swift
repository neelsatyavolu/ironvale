// Lock-free single-producer single-consumer ring for plain-data values (PLAN.md 3.8): the main
// thread pushes commands, the render thread pops them, and back the other way for ended notices.
// Storage is allocated once; push and pop never allocate or lock.

import Synchronization

public final class SPSCRing<Element: BitwiseCopyable>: @unchecked Sendable {
    private let storage: UnsafeMutablePointer<Element>
    private let mask: Int
    /// Next index to write; written by the producer only.
    private let head = Atomic<Int>(0)
    /// Next index to read; written by the consumer only.
    private let tail = Atomic<Int>(0)
    /// Pushes refused because the ring was full.
    private let dropped = Atomic<Int>(0)

    /// `capacity` is rounded up to a power of two.
    public init(capacity: Int) {
        var size = 1
        while size < capacity { size <<= 1 }
        storage = .allocate(capacity: size)
        mask = size - 1
    }

    deinit {
        storage.deallocate()
    }

    public var capacity: Int { mask + 1 }
    public var droppedCount: Int { dropped.load(ordering: .relaxed) }

    /// Producer side. Returns false (and counts a drop) when full.
    @discardableResult
    public func push(_ value: Element) -> Bool {
        let h = head.load(ordering: .relaxed)
        if h - tail.load(ordering: .acquiring) > mask {
            dropped.add(1, ordering: .relaxed)
            return false
        }
        (storage + (h & mask)).initialize(to: value)
        head.store(h + 1, ordering: .releasing)
        return true
    }

    /// Consumer side.
    public func pop() -> Element? {
        let t = tail.load(ordering: .relaxed)
        if t == head.load(ordering: .acquiring) { return nil }
        let value = (storage + (t & mask)).pointee
        tail.store(t + 1, ordering: .releasing)
        return value
    }
}
