// Map-wide textures the surface programs sample (scene.json `programTextures`, written by
// native/Tools/map-export/page/programs-harbor.ts): Harbor's grime atlas, street shade bake,
// wave slopes and boat lettering. Bound once per scene pass at IV_TEXTURE_GRIME ...
// IV_TEXTURE_LETTERING (Shaders/MapSurface.h); maps without them get a white texel there.
import Foundation
import IronvaleRender
import Metal

@MainActor
struct ProgramTextures {
    /// Texture slots, in IV_TEXTURE_GRIME ... IV_TEXTURE_LETTERING order.
    nonisolated static let names = ["grime", "shade", "waves", "lettering"]
    nonisolated static let firstSlot = 9

    let textures: [any MTLTexture]

    init(scene: MapRenderScene, assets: MapAssets, loader: TextureLoader, device: any MTLDevice,
         queue: any MTLCommandQueue, white: any MTLTexture) throws {
        let renderDir = assets.package.appending(path: "render")
        textures = try Self.names.map { name in
            guard let index = scene.programTextures?[name] else { return white }
            let t = scene.textures[index]
            guard let uri = t.uri else { throw MapRenderScene.LoadError.wrongFormat("program texture \(name) has no data", 1) }
            switch t.kind {
            case "png": return try loader.load(renderDir.appending(path: uri), srgb: t.colorSpace == "srgb")
            case "url": return try loader.load(assets.publicRoot.appending(path: uri), srgb: t.colorSpace == "srgb")
            case "raw": return try Self.raw(t, url: renderDir.appending(path: uri), name: name, device: device, queue: queue)
            default: throw MapRenderScene.LoadError.wrongFormat("program texture \(name) is \(t.kind)", 1)
            }
        }
    }

    /// An RGBA8 DataTexture (three uploads its rows as given, flipY false), mipmapped when three mipmaps it.
    private static func raw(_ t: MapRenderScene.Texture, url: URL, name: String, device: any MTLDevice,
                            queue: any MTLCommandQueue) throws -> any MTLTexture {
        guard let width = t.width, let height = t.height, t.dataType == "u8" else {
            throw MapRenderScene.LoadError.wrongFormat("program texture \(name) is not 8-bit RGBA", 1)
        }
        let bytes = try Data(contentsOf: url)
        guard bytes.count == width * height * 4 else {
            throw MapRenderScene.LoadError.wrongFormat("program texture \(name): \(bytes.count) bytes for \(width)x\(height) RGBA", 1)
        }
        let mipmapped = t.generateMipmaps == true
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: width, height: height, mipmapped: mipmapped)
        descriptor.usage = .shaderRead
        guard let texture = device.makeTexture(descriptor: descriptor) else { throw RenderError.allocation("program texture \(name)") }
        texture.label = "program \(name)"
        bytes.withUnsafeBytes { raw in
            texture.replace(region: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0, withBytes: raw.baseAddress!, bytesPerRow: width * 4)
        }
        if mipmapped {
            guard let commands = queue.makeCommandBuffer(), let blit = commands.makeBlitCommandEncoder() else {
                throw RenderError.allocation("mipmap blit")
            }
            blit.generateMipmaps(for: texture)
            blit.endEncoding()
            commands.commit()
            commands.waitUntilCompleted()
        }
        return texture
    }
}
