// Ported from src/characters/pose.ts at commit f14381f. Rotations and hips are Float like the web's
// Float32Arrays; the blending maths runs in Double like JavaScript numbers.
import Foundation

/// Clip data on flat arrays: frames x bones x 4 rotations and frames x 3 hips positions.
public struct ClipData: Sendable {
    public let bones: Int
    public let frames: Int
    public let fps: Double
    public let loop: Bool
    /// Seconds for one pass. A loop's last frame leads back into its first.
    public let duration: Double
    public let rotations: [Float]
    public let hips: [Float]

    public init(bones: Int, frames: Int, fps: Double, loop: Bool, rotations: [Float], hips: [Float]) {
        self.bones = bones
        self.frames = frames
        self.fps = fps
        self.loop = loop
        duration = Double(loop ? frames : frames - 1) / fps
        self.rotations = rotations
        self.hips = hips
    }
}

/// Local rotation of each animated bone plus the hips position.
public struct Pose: Sendable {
    public var rotations: [Float]
    public var hips: [Float] = [0, 0, 0]

    public init(bones: Int) {
        rotations = [Float](repeating: 0, count: bones * 4)
        for i in 0..<bones { rotations[i * 4 + 3] = 1 }
    }

    public func rotation(_ bone: Int) -> Quat {
        Quat(Double(rotations[bone * 4]), Double(rotations[bone * 4 + 1]), Double(rotations[bone * 4 + 2]), Double(rotations[bone * 4 + 3]))
    }
}

/// Normalised lerp along the shorter arc, three's `lerpQuat` in pose.ts.
@inline(__always)
private func lerpQuat(_ a: (Double, Double, Double, Double), _ b: (Double, Double, Double, Double), _ mix: Double) -> (Float, Float, Float, Float) {
    let sign = a.0 * b.0 + a.1 * b.1 + a.2 * b.2 + a.3 * b.3 < 0 ? -mix : mix
    let keep = 1 - mix
    let x = a.0 * keep + b.0 * sign
    let y = a.1 * keep + b.1 * sign
    let z = a.2 * keep + b.2 * sign
    let w = a.3 * keep + b.3 * sign
    let length = (x * x + y * y + z * z + w * w).squareRoot()
    let scale = 1 / (length == 0 ? 1 : length)
    return (Float(x * scale), Float(y * scale), Float(z * scale), Float(w * scale))
}

@inline(__always)
private func quad(_ a: [Float], _ i: Int) -> (Double, Double, Double, Double) {
    (Double(a[i]), Double(a[i + 1]), Double(a[i + 2]), Double(a[i + 3]))
}

/// Writes the clip's pose at `time` seconds into `out`. Loops wrap; one-shots hold their ends.
public func sampleClip(_ clip: ClipData, _ time: Double, _ out: inout Pose) {
    let frames = clip.frames
    var position = time * clip.fps
    let a: Int
    let b: Int
    if clip.loop {
        position -= (position / Double(frames)).rounded(.down) * Double(frames)
        a = Int(position.rounded(.down)) % frames
        b = (a + 1) % frames
    } else {
        position = min(Double(frames - 1), max(0, position))
        a = Int(position.rounded(.down))
        b = min(frames - 1, a + 1)
    }
    let mix = position - position.rounded(.down)
    let rowA = a * clip.bones * 4
    let rowB = b * clip.bones * 4
    clip.rotations.withUnsafeBufferPointer { source in
        out.rotations.withUnsafeMutableBufferPointer { target in
            var i = 0
            while i < clip.bones * 4 {
                let r = lerpQuat((Double(source[rowA + i]), Double(source[rowA + i + 1]), Double(source[rowA + i + 2]), Double(source[rowA + i + 3])),
                                 (Double(source[rowB + i]), Double(source[rowB + i + 1]), Double(source[rowB + i + 2]), Double(source[rowB + i + 3])), mix)
                target[i] = r.0; target[i + 1] = r.1; target[i + 2] = r.2; target[i + 3] = r.3
                i += 4
            }
        }
    }
    for k in 0..<3 {
        let ha = Double(clip.hips[a * 3 + k]), hb = Double(clip.hips[b * 3 + k])
        out.hips[k] = Float(ha + (hb - ha) * mix)
    }
}

/// `out` moves `weight` of the way toward `other`.
public func blendPose(_ out: inout Pose, _ other: Pose, _ weight: Double) {
    if weight <= 0 { return }
    var i = 0
    while i < out.rotations.count {
        let r = lerpQuat(quad(out.rotations, i), quad(other.rotations, i), weight)
        out.rotations[i] = r.0; out.rotations[i + 1] = r.1; out.rotations[i + 2] = r.2; out.rotations[i + 3] = r.3
        i += 4
    }
    for k in 0..<3 {
        let h = Double(out.hips[k])
        out.hips[k] = Float(h + (Double(other.hips[k]) - h) * weight)
    }
}

/// Pulls one bone's rotation `weight` of the way toward `target`.
public func steerBone(_ pose: inout Pose, _ bone: Int, _ target: Quat, _ weight: Double) {
    if weight <= 0 { return }
    // pose.ts copies the target into a Float32Array scratch first.
    let t = (Double(Float(target.x)), Double(Float(target.y)), Double(Float(target.z)), Double(Float(target.w)))
    let r = lerpQuat(quad(pose.rotations, bone * 4), t, weight)
    pose.rotations[bone * 4] = r.0; pose.rotations[bone * 4 + 1] = r.1
    pose.rotations[bone * 4 + 2] = r.2; pose.rotations[bone * 4 + 3] = r.3
}
