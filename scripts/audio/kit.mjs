// Shared helpers for the recipe files: cached source decoding, take selection and the recipe list.
import * as d from './dsp.mjs';

let sourcePaths = {};
const decoded = new Map();

export function setSourcePaths(paths) {
  sourcePaths = paths;
}

/** Decoded source clip (cached). Treat as read-only. */
export function src(key, channels = 1) {
  const cacheKey = `${key}/${channels}`;
  if (!decoded.has(cacheKey)) {
    if (!sourcePaths[key]) throw new Error(`Unknown source "${key}"`);
    decoded.set(cacheKey, d.decode(sourcePaths[key], channels));
  }
  return decoded.get(cacheKey);
}

const segmentCache = new Map();

/** Segments of a source (cached per option set), found on the mono mix. */
export function segs(key, options = {}) {
  const cacheKey = `${key}/${JSON.stringify(options)}`;
  if (!segmentCache.has(cacheKey)) segmentCache.set(cacheKey, d.segments(src(key, 1), options));
  return segmentCache.get(cacheKey);
}

/** Start time of the n-th full-level take in a file that holds several takes of one event. */
export function takeStart(key, index, within = 14) {
  const all = segs(key, { thresholdDb: -40, minGap: 0.15, minLength: 0.05 });
  const top = Math.max(...all.map((s) => s.peakDb));
  const takes = all.filter((s) => s.peakDb > top - within);
  const take = takes[Math.min(index, takes.length - 1)];
  if (!take) throw new Error(`No take ${index} in ${key}`);
  return take.start;
}

/** `length` seconds of a source starting at `start`, onset aligned to the first loud sample. */
export function from(key, start, length, channels = 1) {
  return d.trimStart(d.cut(src(key, channels), Math.max(0, start - 0.01), start + length + 0.01), -26, 0.0015);
}

/** The n-th segment of a source as a clip, with `extra` seconds of ring-out kept. */
export function part(key, index, options = {}, extra = 0.05, channels = 1) {
  const all = segs(key, options);
  const s = all[index];
  if (!s) throw new Error(`Source ${key} has no segment ${index} (found ${all.length})`);
  return d.cut(src(key, channels), s.start, s.end + extra);
}

/**
 * Choose `count` separate events from a long take: segments inside `range`
 * whose length fits and whose peak is within `within` dB of the loudest, spread
 * evenly through the file so neighbouring takes are not near-duplicates.
 */
export function pick(key, count, { range = [0, Infinity], minLength = 0.06, maxLength = 0.7, within = 12, extra = 0.08, ...options } = {}) {
  const all = segs(key, { thresholdDb: -24, minGap: 0.07, minLength: 0.04, ...options }).filter(
    (s) => s.start >= range[0] && s.end <= range[1] && s.end - s.start >= minLength && s.end - s.start <= maxLength,
  );
  const top = Math.max(...all.map((s) => s.peakDb));
  // Widen the level window until there are enough events; quiet takes are levelled afterwards anyway.
  let good = [];
  for (let range = within; range <= 40 && good.length < count; range += 4) good = all.filter((s) => s.peakDb > top - range);
  if (good.length < count) throw new Error(`Source ${key} has only ${good.length} usable events, wanted ${count}`);
  return Array.from({ length: count }, (_, i) => {
    const s = good[Math.floor(((i + 0.5) * good.length) / count)];
    return d.cut(src(key, 1), s.start, s.end + extra);
  });
}

/** Clean one-shot edges: tight start, tail trimmed, short fades. */
export function oneShot(clip, fadeOut = 0.03, endDb = -48) {
  return d.fade(d.trim(clip, -34, endDb), 0.001, fadeOut);
}

// ---------------------------------------------------------------- recipes

/** @type {{ id: string, sources: string[], stereo: boolean, kbps: number, loop: null | { body: number }, note: string, build: () => Float32Array[] }[]} */
export const recipes = [];

/**
 * Register one output file. `sources` are keys from sources.mjs ('synth' for
 * generated material); they set the licence and credit in the manifest.
 */
export function add(id, sources, build, { stereo = false, kbps, loop = null, note = '' } = {}) {
  if (recipes.some((recipe) => recipe.id === id)) throw new Error(`Duplicate sound id ${id}`);
  recipes.push({ id, sources, stereo, kbps: kbps ?? (stereo ? 160 : 128), loop, note, build });
}

/** Register numbered variations `${group}-1..n`. */
export function addSet(group, sources, clips, options) {
  clips.forEach((makeClip, i) => add(`${group}-${i + 1}`, Array.isArray(sources[0]) ? sources[i] : sources, makeClip, options));
}

/**
 * Variations that should sound like one source: build them all, tilt each to
 * the set's median spectral centroid, then finish (level) each. Returns one
 * maker per variation; the set is computed once.
 */
export function matched(makers, finish = (clip) => clip, range = 9) {
  let cache = null;
  const all = () => {
    if (!cache) {
      const clips = makers.map((make) => make());
      const centroids = clips.map((clip) => d.centroid(clip)).sort((a, b) => a - b);
      const target = centroids[Math.floor(centroids.length / 2)];
      cache = clips.map((clip) => finish(d.matchCentroid(clip, target, range)));
    }
    return cache;
  };
  return makers.map((_, i) => () => all()[i]);
}
