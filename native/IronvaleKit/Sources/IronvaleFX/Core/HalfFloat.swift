// three's DataUtils.toHalfFloat (src/extras/DataUtils.js, r187): float32 to binary16 bits by table,
// truncating the mantissa. The web uploads the roof mask this way (weather.ts), so the native mask
// texture holds the same half-float heights.

public enum HalfFloat {
    private static let tables: (base: [UInt16], shift: [UInt32]) = {
        var base = [UInt16](repeating: 0, count: 512), shift = [UInt32](repeating: 0, count: 512)
        for i in 0..<256 {
            let e = i - 127
            if e < -27 {
                base[i] = 0x0000; base[i | 0x100] = 0x8000; shift[i] = 24; shift[i | 0x100] = 24
            } else if e < -14 {
                base[i] = UInt16(0x0400 >> (-e - 14)); base[i | 0x100] = UInt16(0x0400 >> (-e - 14)) | 0x8000
                shift[i] = UInt32(-e - 1); shift[i | 0x100] = UInt32(-e - 1)
            } else if e <= 15 {
                base[i] = UInt16((e + 15) << 10); base[i | 0x100] = UInt16((e + 15) << 10) | 0x8000; shift[i] = 13; shift[i | 0x100] = 13
            } else if e < 128 {
                base[i] = 0x7c00; base[i | 0x100] = 0xfc00; shift[i] = 24; shift[i | 0x100] = 24
            } else {
                base[i] = 0x7c00; base[i | 0x100] = 0xfc00; shift[i] = 13; shift[i | 0x100] = 13
            }
        }
        return (base, shift)
    }()

    public static func bits(_ value: Float) -> UInt16 {
        let clamped = Swift.min(Swift.max(value, -65504), 65504)
        let f = clamped.bitPattern
        let e = Int((f >> 23) & 0x1ff)
        return tables.base[e] &+ UInt16(truncatingIfNeeded: (f & 0x007fffff) >> tables.shift[e])
    }
}
