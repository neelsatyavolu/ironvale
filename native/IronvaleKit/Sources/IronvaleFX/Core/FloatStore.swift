// Page-aligned float storage the effects write their per-instance data into. The GPU layer wraps it
// in an MTLBuffer without a copy (makeBuffer(bytesNoCopy:)), so a frame uploads nothing: as on the
// web, each instance is written once, at birth, and the vertex shader animates it from its age.
import Darwin

public final class FloatStore: @unchecked Sendable {
    public let count: Int
    public let byteLength: Int
    public let pointer: UnsafeMutablePointer<Float>

    public init(count: Int) {
        self.count = count
        let page = Int(getpagesize())
        byteLength = max(page, (count * MemoryLayout<Float>.stride + page - 1) / page * page)
        var raw: UnsafeMutableRawPointer?
        guard posix_memalign(&raw, page, byteLength) == 0, let raw else { fatalError("FloatStore: out of memory") }
        raw.initializeMemory(as: UInt8.self, repeating: 0, count: byteLength)
        pointer = raw.bindMemory(to: Float.self, capacity: byteLength / MemoryLayout<Float>.stride)
    }

    deinit { free(pointer) }

    @inline(__always) public subscript(i: Int) -> Float {
        get { pointer[i] }
        set { pointer[i] = newValue }
    }

    public func zero() { pointer.update(repeating: 0, count: count) }

    /// Row `slot` of a buffer with `stride` floats per row.
    @inline(__always) public func row(_ slot: Int, _ stride: Int) -> UnsafeMutablePointer<Float> { pointer + slot * stride }
}
