// Copied from IronvaleAudioTests/MallocHook.swift (test targets cannot share sources): counts heap
// allocations made on threads inside a marked region, through libmalloc's `malloc_logger` hook.
//
// Each region kind has its own counter and stack ring, so tests that run in parallel (the offline
// check's deliberate positive-control allocation, the live soak) never see each other's counts.

import Darwin
import Foundation
import Synchronization

typealias MallocLogger = @convention(c) (UInt32, UInt, UInt, UInt, UInt, UInt32) -> Void

/// Which marked region a thread is in. The raw value is stored in the thread's hook key.
enum MallocRegion: Int, CaseIterable {
    /// MixCoreTests: render calls made directly by the test thread.
    case offline = 1
    /// SoakTests: the Core Audio render thread, marked by `MallocProbe`.
    case live = 2
}

/// Allocations seen inside marked regions, per region.
private let offlineCount = Atomic<Int>(0)
private let liveCount = Atomic<Int>(0)
nonisolated(unsafe) var mallocHookKey = pthread_key_t()
private let installLock = Mutex<Bool>(false)

private let mallocHookSlots = 8
private let mallocHookDepth = 32
/// Latest call stacks per region (fixed rings; the hook must not allocate).
nonisolated(unsafe) private let mallocHookStacks: UnsafeMutablePointer<UnsafeMutableRawPointer?> = {
    let size = (MallocRegion.allCases.count + 1) * mallocHookSlots * mallocHookDepth
    let p = UnsafeMutablePointer<UnsafeMutableRawPointer?>.allocate(capacity: size)
    p.initialize(repeating: nil, count: size)
    return p
}()

private func stackSlot(_ tag: Int, _ n: Int) -> UnsafeMutablePointer<UnsafeMutableRawPointer?> {
    mallocHookStacks.advanced(by: (tag * mallocHookSlots + (n - 1) % mallocHookSlots) * mallocHookDepth)
}

/// libmalloc's logger types: 2 = allocate (malloc, calloc, realloc's new block), 4 = deallocate.
private let mallocHookCallback: MallocLogger = { type, _, _, _, _, _ in
    guard type & 2 != 0, let marked = pthread_getspecific(mallocHookKey) else { return }
    let tag = Int(bitPattern: marked)
    let n: Int
    switch tag {
    case MallocRegion.offline.rawValue: n = offlineCount.add(1, ordering: .relaxed).newValue
    case MallocRegion.live.rawValue: n = liveCount.add(1, ordering: .relaxed).newValue
    default: return
    }
    // Keep the latest call stacks for the failure message (unmarked while walking the stack).
    pthread_setspecific(mallocHookKey, nil)
    let slot = stackSlot(tag, n)
    slot.update(repeating: nil, count: mallocHookDepth)
    _ = backtrace(slot, Int32(mallocHookDepth))
    pthread_setspecific(mallocHookKey, marked)
}

/// Symbolized call stacks of the `region` allocations counted after `since` (the latest few).
func mallocHookReport(_ region: MallocRegion, since: Int) -> String {
    let count = MallocHook.count(region)
    guard count > since else { return "" }
    var lines: [String] = []
    for n in max(since + 1, count - mallocHookSlots + 1)...count {
        lines.append(" allocation \(n):")
        let slot = stackSlot(region.rawValue, n)
        for f in 0..<mallocHookDepth {
            guard let address = slot[f] else { break }
            var info = Dl_info()
            var line = "    \(address)"
            if dladdr(address, &info) != 0 {
                let image = info.dli_fname.map { String(cString: $0).split(separator: "/").last.map(String.init) ?? "" } ?? "?"
                let symbol = info.dli_sname.map { String(cString: $0) } ?? "?"
                line += " \(image) \(symbol)"
            }
            lines.append(line)
        }
    }
    return lines.joined(separator: "\n")
}

enum MallocHook {
    /// Install the logger once per process. Returns false when the symbol is not available.
    static func install() -> Bool {
        installLock.withLock { installed in
            if installed { return true }
            guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "malloc_logger") else { return false }
            pthread_key_create(&mallocHookKey, nil)
            symbol.assumingMemoryBound(to: MallocLogger?.self).pointee = mallocHookCallback
            installed = true
            return true
        }
    }

    /// Mark the current thread as counted in `region`, or unmark it (nil).
    @inline(__always) static func counting(_ region: MallocRegion?) {
        pthread_setspecific(mallocHookKey, region.flatMap { UnsafeRawPointer(bitPattern: $0.rawValue) })
    }

    static func count(_ region: MallocRegion) -> Int {
        switch region {
        case .offline: offlineCount.load(ordering: .relaxed)
        case .live: liveCount.load(ordering: .relaxed)
        }
    }
}

