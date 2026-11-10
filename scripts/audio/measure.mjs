// Measures every encoded file with ffmpeg (astats, silencedetect, loudnorm) and
// a decode of our own (duration, overs, spectral centroid, loop seam).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { centroid, decode, duration, FFMPEG, LOOP_ROLL, SR } from './dsp.mjs';

const run = promisify(execFile);

async function ffmpegStats(file) {
  const { stderr } = await run(
    FFMPEG,
    ['-hide_banner', '-nostats', '-i', file, '-af', 'astats=measure_perchannel=none,silencedetect=noise=-45dB:d=0.004,apad=pad_dur=0.6,loudnorm=print_format=json', '-f', 'null', '-'],
    { maxBuffer: 1 << 24 },
  );
  const number = (pattern) => {
    const match = stderr.match(pattern);
    return match ? Number(match[1]) : NaN;
  };
  // Leading silence: a silence run that starts at 0 ends where the sound begins.
  const first = stderr.match(/silence_start: (-?[\d.]+)[\s\S]*?silence_end: ([\d.]+)/);
  const onsetMs = first && Number(first[1]) <= 0.001 ? Number(first[2]) * 1000 : 0;
  const json = JSON.parse(stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1));
  return {
    peakDb: number(/Peak level dB: (-?[\d.]+|-inf)/),
    rmsDb: number(/RMS level dB: (-?[\d.]+|-inf)/),
    onsetMs,
    lufs: Number(json.input_i),
    truePeakDb: Number(json.input_tp),
  };
}

/**
 * Size of the jump from the last sample of the loop to its first, in units of
 * the signal's ordinary sample-to-sample step. About 1 is seamless; a click is 5 or more.
 */
function seamStep(clip, body) {
  const start = Math.round(LOOP_ROLL * SR);
  const end = start + Math.round(body * SR);
  let worst = 0;
  for (const channel of clip) {
    if (end >= channel.length) return NaN;
    let sum = 0;
    for (let i = start + 1; i < end; i++) sum += (channel[i] - channel[i - 1]) ** 2;
    const typical = Math.sqrt(sum / (end - start - 1));
    worst = Math.max(worst, Math.abs(channel[start] - channel[end - 1]) / Math.max(typical, 1e-9));
  }
  return worst;
}

export async function measure(file, recipe) {
  const clip = decode(file, recipe.stereo ? 2 : 1);
  let overs = 0;
  for (const channel of clip) for (let i = 0; i < channel.length; i++) if (Math.abs(channel[i]) > 1) overs++;
  return {
    ...(await ffmpegStats(file)),
    duration: duration(clip),
    centroidHz: Math.round(centroid(clip)),
    overs,
    seamStep: recipe.loop ? seamStep(clip, recipe.loop.body) : null,
    samples: clip[0].length,
    sampleRate: SR,
  };
}

export async function measureAll(items, parallel = 6) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await measure(items[index].file, items[index].recipe);
      }
    }),
  );
  return results;
}
