/**
 * Developer tap on the master output, after the limiter: what the player
 * hears. Used by scripts/dev/audio-check.mjs to measure the mix in the page.
 */
import type { AudioGraph } from './graph';
import type { VoicePool } from './pool';

export interface AudioCapture {
  /** The most recent samples of each output channel (about 0.68 s at 48 kHz). */
  readonly left: Float32Array;
  readonly right: Float32Array;
  /** Context time of the last sample, in seconds. */
  readonly endTime: number;
  readonly sampleRate: number;
}

export interface AudioDebug {
  readonly context: AudioContext;
  /** Voices sounding now. */
  readonly playing: number;
  /** Voices using the HRTF panner now. */
  readonly hrtf: number;
  /** true once the current map's sounds are decoded and its ambience has started. */
  readonly mapReady: boolean;
  /** Sound ids decoded so far. */
  readonly decoded: readonly string[];
  capture(): AudioCapture;
}

export function createDebug(graph: AudioGraph, pool: VoicePool, mapReady: () => boolean, decoded: () => string[]): AudioDebug {
  return {
    context: graph.context,
    get playing() {
      return pool.playing;
    },
    get hrtf() {
      return pool.hrtfCount;
    },
    get mapReady() {
      return mapReady();
    },
    get decoded() {
      return decoded();
    },
    capture() {
      const left = new Float32Array(graph.tapLeft.fftSize);
      const right = new Float32Array(graph.tapRight.fftSize);
      graph.tapLeft.getFloatTimeDomainData(left);
      graph.tapRight.getFloatTimeDomainData(right);
      return { left, right, endTime: graph.context.currentTime, sampleRate: graph.context.sampleRate };
    },
  };
}
