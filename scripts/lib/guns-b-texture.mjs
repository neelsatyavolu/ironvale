// Texture helpers for the guns-b processing script (m24).
import { EXTTextureWebP } from '@gltf-transform/extensions';
import sharp from 'sharp';

/**
 * Re-encodes a texture as WebP at `size` pixels square. `edit(pixels, channels)`
 * may change the raw RGB(A) bytes in place before encoding.
 */
export async function encodeWebp(doc, texture, { size, quality = 88, edit, nearLossless = false }) {
  doc.createExtension(EXTTextureWebP).setRequired(true);
  const { data, info } = await sharp(texture.getImage())
    .resize(size, size, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (edit) edit(data, info.channels);
  const webp = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
    .webp({ quality, nearLossless, effort: 6, smartSubsample: true })
    .toBuffer();
  texture.setImage(new Uint8Array(webp)).setMimeType('image/webp');
  const uri = texture.getURI();
  if (uri) texture.setURI(uri.replace(/\.(png|jpe?g)$/i, '.webp'));
  return webp.length;
}

/** Raw RGB bytes of a texture at `size` pixels square. */
export async function rawPixels(texture, size) {
  return sharp(texture.getImage()).resize(size, size, { fit: 'fill', kernel: 'lanczos3' }).removeAlpha().raw().toBuffer();
}

/**
 * Pixel edit for an occlusion-roughness-metal map: squeezes roughness (green)
 * into [floor, 1], with separate floors for metal and non-metal texels, so
 * surfaces authored for a studio viewer do not turn into mirrors under a sky.
 */
export function liftRoughness({ metal, other }) {
  return (pixels) => {
    for (let i = 0; i < pixels.length; i += 3) {
      const metalness = pixels[i + 2] / 255;
      const floor = other + (metal - other) * metalness;
      pixels[i + 1] = Math.round((floor + (1 - floor) * (pixels[i + 1] / 255)) * 255);
    }
  };
}
