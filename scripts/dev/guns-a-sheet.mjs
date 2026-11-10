// Joins images side by side into one sheet for review.
// Usage: node scripts/dev/guns-a-sheet.mjs <out.png> <cellSize> <image>... (an image may be "file@left,top,width,height" to crop first)
import sharp from 'sharp';

const [out, sizeText, ...inputs] = process.argv.slice(2);
const size = Number(sizeText);
const cells = await Promise.all(
  inputs.map(async (input) => {
    const [file, crop] = input.split('@');
    let image = sharp(file);
    if (crop) {
      const [left, top, width, height] = crop.split(',').map(Number);
      image = image.extract({ left, top, width, height });
    }
    return image.resize(size, size, { fit: 'contain', background: '#202020' }).png().toBuffer();
  }),
);
await sharp({ create: { width: size * cells.length, height: size, channels: 3, background: '#202020' } })
  .composite(cells.map((input, i) => ({ input, left: i * size, top: 0 })))
  .png()
  .toFile(out);
