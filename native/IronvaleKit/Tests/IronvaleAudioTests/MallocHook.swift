// Counts heap allocations made on threads that are inside a marked region, through libmalloc's
// `malloc_logger` hook (the same hook MallocStackLogging uses). Used to prove MixCore.render
// allocates nothing, offline and on the real Core Audio render thread.

import Darwin
import Foundation
import IronvaleAudio
import Synchronization

typealias MallocLogger = @convention(c) (UInt32, UInt, UInt, UInt, UInt, UInt32) -> Void

/// Allocations seen inside marked regions.
let mallocHookCount = Atomic<Int>(0)
nonisolated(unsafe) var mallocHookKey = pthread_key_t()
private let installLock = Mutex<Bool>(false)

/// libmalloc's logger types: 2 = allocate (malloc, calloc, realloc's new block), 4 = deallocate.
private let mallocHookCallback: MallocLogger = { type, _, _, _, _, _ in
    if type & 2 != 0, pthread_getspecific(mallocHookKey) != nil {
        let n = mallocHookCount.add(1, ordering: .relaxed).newValue
        if n <= 4 {
            // Keep the first few call stacks (no allocation: a fixed buffer) for the failure message.
            pthread_setspecific(mallocHookKey, nil)
            _ = backtrace(mallocHookStacks.advanced(by: (n - 1) * 24), 24)
            pthread_setspecific(mallocHookKey, UnsafeRawPointer(bitPattern: 1))
        }
    }
}

nonisolated(unsafe) let mallocHookStacks = UnsafeMutablePointer<UnsafeMutableRawPointer?>.allocate(capacity: 4 * 24)

/// Symbol names of the first recorded allocation stacks.
func mallocHookReport() -> String {
    var lines: [String] = []
    for s in 0..<min(4, mallocHookCount.load(ordering: .relaxed)) {
        for f in 0..<24 {
            guard let address = mallocHookStacks[s * 24 + f] else { break }
            var info = Dl_info()
            if dladdr(address, &info) != 0, let name = info.dli_sname { lines.append("  \(s): \(String(cString: name))") }
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

    /// Mark the current thread as counted (true) or not.
    @inline(__always) static func counting(_ on: Bool) {
        pthread_setspecific(mallocHookKey, on ? UnsafeRawPointer(bitPattern: 1) : nil)
    }

    static var count: Int { mallocHookCount.load(ordering: .relaxed) }
}

/// Marks the render thread for the duration of each render call.
final class MallocProbe: RenderProbe {
    func enter() { MallocHook.counting(true) }
    func leave() { MallocHook.counting(false) }
}
