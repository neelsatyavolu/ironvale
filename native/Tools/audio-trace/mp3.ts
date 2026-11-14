/**
 * Decoded length of an MP3 without decoding it: count MPEG audio frames, skip the Xing/Info
 * header frame and take off the LAME encoder delay and padding, as gapless decoders do.
 * The trace scenes use these lengths as the decoded duration of every sound on both sides.
 */
const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const RATES: Record<number, readonly number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

export interface Mp3Length {
  readonly sampleRate: number;
  /** Samples per channel after the encoder delay and padding are removed. */
  readonly samples: number;
}

export function mp3Length(bytes: Uint8Array): Mp3Length {
  let i = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
    i = 10 + size + (bytes[5]! & 0x10 ? 10 : 0);
  }
  let frames = 0;
  let sampleRate = 0;
  let perFrame = 0;
  let delay = 0;
  let padding = 0;
  let first = true;
  while (i + 4 <= bytes.length) {
    const b1 = bytes[i + 1]!;
    const b2 = bytes[i + 2]!;
    if (bytes[i] !== 0xff || (b1 & 0xe0) !== 0xe0) {
      i++;
      continue;
    }
    const version = (b1 >> 3) & 3;
    const layer = (b1 >> 1) & 3;
    const bitrateIndex = b2 >> 4;
    const rateIndex = (b2 >> 2) & 3;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
      i++;
      continue;
    }
    const v1 = version === 3;
    const bitrate = (v1 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIndex]! * 1000;
    const rate = RATES[version]![rateIndex]!;
    const pad = (b2 >> 1) & 1;
    const length = Math.floor(((v1 ? 144 : 72) * bitrate) / rate) + pad;
    sampleRate = rate;
    perFrame = v1 ? 1152 : 576;
    if (first) {
      first = false;
      const mono = (bytes[i + 3]! >> 6) === 3;
      const side = v1 ? (mono ? 17 : 32) : mono ? 9 : 17;
      const tag = String.fromCharCode(...bytes.subarray(i + 4 + side, i + 8 + side));
      if (tag === 'Xing' || tag === 'Info') {
        // LAME tag: 21 bytes in, delay (12 bits) and padding (12 bits). The ffmpeg-written tags ("Lavc")
        // in this repo are not trimmed: that matches AVAudioFile for all but a handful of files (within 52 ms).
        const lame = i + 4 + side + 120;
        if (String.fromCharCode(...bytes.subarray(lame, lame + 4)) === 'LAME') {
          const d = lame + 21;
          delay = (bytes[d]! << 4) | (bytes[d + 1]! >> 4);
          padding = ((bytes[d + 1]! & 0x0f) << 8) | bytes[d + 2]!;
        }
        i += length;
        continue;
      }
    }
    frames++;
    i += length;
  }
  if (frames === 0) throw new Error('no MPEG audio frames');
  // Decoders also drop the 529-sample decoder delay when they honour the LAME tag.
  const skip = delay > 0 ? delay + 529 : 0;
  const trimmed = padding > 0 ? Math.max(0, padding - 529) : 0;
  return { sampleRate, samples: Math.max(0, frames * perFrame - skip - trimmed) };
}
