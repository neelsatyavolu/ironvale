import CoreGraphics
import Foundation
import ImageIO
import Metal
import MetalKit
import UniformTypeIdentifiers

public enum RenderError: Error, CustomStringConvertible {
    case missingFunction(String)
    case allocation(String)
    case textureLoad(URL, String)
    case readback(String)

    public var description: String {
        switch self {
        case .missingFunction(let name): "Shader function \(name) is missing from default.metallib"
        case .allocation(let what): "Metal could not allocate \(what)"
        case .textureLoad(let url, let why): "Could not load texture \(url.path): \(why)"
        case .readback(let why): "Could not read back the frame: \(why)"
        }
    }
}

/// Image files to mipmapped, GPU-private Metal textures (JPG and PNG through MetalKit).
@MainActor
public final class TextureLoader {
    private let device: any MTLDevice
    private let loader: MTKTextureLoader
    private var cache: [String: any MTLTexture] = [:]

    public init(device: any MTLDevice) {
        self.device = device
        self.loader = MTKTextureLoader(device: device)
    }

    /// Loads `url` once per (path, colour space). `srgb` true decodes the texels as sRGB.
    public func load(_ url: URL, srgb: Bool) throws -> any MTLTexture {
        let key = "\(url.path)|\(srgb)"
        if let known = cache[key] { return known }
        do {
            let texture = try loader.newTexture(URL: url, options: [
                .SRGB: srgb,
                .generateMipmaps: true,
                .textureStorageMode: MTLStorageMode.private.rawValue,
                .textureUsage: MTLTextureUsage.shaderRead.rawValue,
            ])
            texture.label = url.lastPathComponent
            cache[key] = texture
            return texture
        } catch {
            throw RenderError.textureLoad(url, "\(error)")
        }
    }

    /// A 1x1 texture of one colour, bound to unused material slots.
    public func solid(_ rgba: SIMD4<UInt8>) throws -> any MTLTexture {
        let key = "solid|\(rgba)"
        if let known = cache[key] { return known }
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: 1, height: 1, mipmapped: false)
        guard let texture = device.makeTexture(descriptor: descriptor) else { throw RenderError.allocation("1x1 texture") }
        var bytes = rgba
        texture.replace(region: MTLRegionMake2D(0, 0, 1, 1), mipmapLevel: 0, withBytes: &bytes, bytesPerRow: 4)
        cache[key] = texture
        return texture
    }
}

/// Reads a `bgra8Unorm` texture back and writes it as PNG.
public enum TextureCapture {
    public static func writePNG(_ texture: any MTLTexture, to url: URL) throws {
        guard texture.pixelFormat == .bgra8Unorm, texture.storageMode != .private else {
            throw RenderError.readback("expected a CPU-visible bgra8Unorm texture")
        }
        let width = texture.width, height = texture.height
        let bytesPerRow = width * 4
        var bytes = [UInt8](repeating: 0, count: bytesPerRow * height)
        texture.getBytes(&bytes, bytesPerRow: bytesPerRow, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0)
        let info = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        guard let provider = CGDataProvider(data: Data(bytes) as CFData),
              let space = CGColorSpace(name: CGColorSpace.sRGB),
              let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: bytesPerRow,
                                  space: space, bitmapInfo: info, provider: provider, decode: nil, shouldInterpolate: false,
                                  intent: .defaultIntent),
              let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
        else { throw RenderError.readback("could not encode PNG") }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw RenderError.readback("could not write \(url.path)") }
    }
}
