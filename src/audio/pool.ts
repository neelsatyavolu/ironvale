/**
 * The voice pool. Every slot keeps its filter, gain and panner nodes for the
 * life of the context; playing a sound only creates the one-use buffer source.
 * Positional voices get distance gain, an air-absorption low-pass, a
 * propagation delay and an occlusion test here.
 */
import type { Vector3 } from 'three/webgpu';
import type { SoundHandle } from '../game/contracts';
import type { World } from '../world/types';
import {
  CLEAR,
  distanceGain,
  finalCutoff,
  occlusionFor,
  PROFILES,
  propagationDelay,
  RaycastBudget,
  type DistanceProfile,
  type Occlusion,
  type SoundClass,
} from './curves';
import type { AudioGraph, BusName } from './graph';
import { PRIORITY, VoiceBook, type Priority } from './voices';

export const MAX_PLAYING = 32;
export const MAX_HRTF = 8;
const SLOTS = 44;
const STEAL_FADE = 0.03;
const RAYCASTS_PER_FRAME = 5;
const LOOP_REFRESH = 0.25;
const OPEN_HZ = 20000;

export interface DecodedSound {
  readonly buffer: AudioBuffer;
  /** Seconds of leading silence to skip (encoder padding differs between browsers). */
  readonly offset: number;
  readonly loopStart: number;
  readonly loopEnd: number;
}

/** Reused for every play call; `reset` then fill in what differs. */
export class PlayRequest {
  sound: DecodedSound | null = null;
  bus: BusName = 'effects';
  /** World position, or null for the listener's own sounds. */
  position: Vector3 | null = null;
  soundClass: SoundClass = 'generic';
  profile: DistanceProfile | null = null;
  volume = 1;
  pitch = 1;
  /** -1 (left) to 1 (right); only for sounds without a position. */
  pan = 0;
  /** 0 - 1 into the reverb. */
  send = 0;
  /** Extra low-pass ceiling in Hz. */
  cutoff = OPEN_HZ;
  priority: Priority = PRIORITY.normal;
  group = '';
  groupCap = 0;
  loop = false;
  /** Seconds to wait on top of any propagation delay. */
  delay = 0;
  occlude = true;
  /** Result of a test already made for this event, so its layers share one ray. */
  occlusion: Occlusion | null = null;
  fadeIn = 0;

  reset(): this {
    this.sound = null;
    this.bus = 'effects';
    this.position = null;
    this.soundClass = 'generic';
    this.profile = null;
    this.volume = 1;
    this.pitch = 1;
    this.pan = 0;
    this.send = 0;
    this.cutoff = OPEN_HZ;
    this.priority = PRIORITY.normal;
    this.group = '';
    this.groupCap = 0;
    this.loop = false;
    this.delay = 0;
    this.occlude = true;
    this.occlusion = null;
    this.fadeIn = 0;
    return this;
  }
}

interface Slot {
  readonly filter: BiquadFilterNode;
  readonly gain: GainNode;
  readonly panner: PannerNode;
  readonly stereo: StereoPannerNode;
  readonly send: GainNode;
  readonly out: GainNode;
  source: AudioBufferSourceNode | null;
  bus: BusName | null;
  usesPanner: boolean | null;
  generation: number;
  // Kept for loops, which are re-evaluated as the listener moves.
  x: number;
  y: number;
  z: number;
  profile: DistanceProfile;
  volume: number;
  cutoff: number;
  occlusion: number;
  refreshIn: number;
}

export const SILENT_HANDLE: SoundHandle = { stop: () => undefined, setVolume: () => undefined };

export class VoicePool {
  readonly book = new VoiceBook(SLOTS, MAX_PLAYING);
  /** Listener position, updated by the engine every frame. */
  readonly listener = { x: 0, y: 0, z: 0 };
  hrtfEnabled = true;

  private readonly slots: Slot[];
  private readonly budget = new RaycastBudget(RAYCASTS_PER_FRAME);
  private readonly changed: number[] = [];
  private readonly from: Vector3;
  private readonly to: Vector3;
  /** Held so the HRTF data stays loaded. */
  readonly hrtfWarmup: PannerNode;

  constructor(
    private readonly graph: AudioGraph,
    private readonly world: () => World,
    scratch: () => Vector3,
  ) {
    this.from = scratch();
    this.to = scratch();
    const context = graph.context;
    // The browser loads its HRTF data the first time an HRTF panner exists, and pans nothing
    // until it has. Asking now means the first shot of a match is already placed.
    this.hrtfWarmup = new PannerNode(context, { panningModel: 'HRTF' });
    this.slots = Array.from({ length: SLOTS }, () => {
      const filter = new BiquadFilterNode(context, { type: 'lowpass', frequency: OPEN_HZ, Q: 0.6 });
      const gain = new GainNode(context, { gain: 0 });
      // The engine computes distance gain itself, so the panner only places the sound.
      const panner = new PannerNode(context, { panningModel: 'equalpower', distanceModel: 'inverse', rolloffFactor: 0, refDistance: 1 });
      const stereo = new StereoPannerNode(context, { pan: 0 });
      const send = new GainNode(context, { gain: 0 });
      const out = new GainNode(context, { gain: 1 });
      filter.connect(gain);
      gain.connect(send).connect(graph.reverbIn);
      panner.connect(out);
      stereo.connect(out);
      return {
        filter, gain, panner, stereo, send, out, source: null, bus: null, usesPanner: null, generation: 0,
        x: 0, y: 0, z: 0, profile: PROFILES.generic, volume: 1, cutoff: OPEN_HZ, occlusion: 1, refreshIn: 0,
      };
    });
  }

  /** Start a sound. Returns the slot index, or -1 when it was out of range, outranked or not loaded. */
  play(request: PlayRequest): number {
    const sound = request.sound;
    if (!sound) return -1;
    const now = this.graph.now;
    const profile = request.profile ?? PROFILES[request.soundClass];
    const position = request.position;

    let distance = 0;
    let level = request.volume;
    let cutoff = request.cutoff;
    let delay = request.delay;
    let occlusion = CLEAR;
    if (position) {
      distance = Math.hypot(position.x - this.listener.x, position.y - this.listener.y, position.z - this.listener.z);
      // A one-shot that starts out of earshot is over before the listener could reach it.
      if (!request.loop && distance >= profile.max) return -1;
      if (request.occlusion) occlusion = request.occlusion;
      else if (request.occlude) occlusion = this.occlusionAt(position);
      level *= distanceGain(distance, profile) * occlusion.gain;
      cutoff = Math.min(cutoff, finalCutoff(distance, profile, occlusion));
      delay += propagationDelay(distance, profile);
    }

    const acquired = this.book.acquire(
      { priority: request.priority, group: request.group, groupCap: request.groupCap, positional: position !== null, distance, loop: request.loop },
      now,
    );
    for (const stolen of acquired.stolen) this.silence(stolen, STEAL_FADE);
    const index = acquired.slot;
    if (index < 0) return -1;

    const slot = this.slots[index]!;
    const startAt = now + delay;
    this.route(slot, request.bus, position !== null);
    if (position) {
      slot.panner.positionX.value = position.x;
      slot.panner.positionY.value = position.y;
      slot.panner.positionZ.value = position.z;
      slot.x = position.x;
      slot.y = position.y;
      slot.z = position.z;
    } else {
      slot.stereo.pan.value = request.pan;
    }
    slot.profile = profile;
    slot.volume = request.volume;
    slot.cutoff = request.cutoff;
    slot.occlusion = occlusion === CLEAR ? 1 : 0;
    slot.refreshIn = (index % 5) * 0.05;

    const gain = slot.gain.gain;
    gain.cancelScheduledValues(now);
    if (request.fadeIn > 0) {
      gain.setValueAtTime(0, now);
      gain.setValueAtTime(0, startAt);
      gain.linearRampToValueAtTime(level, startAt + request.fadeIn);
    } else {
      gain.setValueAtTime(level, now);
    }
    slot.filter.frequency.cancelScheduledValues(now);
    slot.filter.frequency.setValueAtTime(Math.min(OPEN_HZ, cutoff), now);
    slot.send.gain.cancelScheduledValues(now);
    slot.send.gain.setValueAtTime(request.send, now);

    const source = new AudioBufferSourceNode(this.graph.context, { buffer: sound.buffer, playbackRate: request.pitch });
    const generation = ++slot.generation;
    if (request.loop) {
      source.loop = true;
      source.loopStart = sound.loopStart;
      source.loopEnd = sound.loopEnd;
    }
    source.onended = () => {
      source.disconnect();
      if (slot.generation !== generation) return;
      slot.source = null;
      this.book.release(index, this.graph.now, 0);
    };
    source.connect(slot.filter);
    source.start(startAt, request.loop ? sound.loopStart : sound.offset);
    slot.source = source;

    if (position) {
      this.refreshHrtf();
      // A pooled HRTF panner crossfades from wherever it last was, which would place the
      // attack of this sound at the old position. Rebuilding it makes it start in place.
      slot.panner.panningModel = 'equalpower';
      if (this.book.voices[index]!.hrtf) slot.panner.panningModel = 'HRTF';
    }
    return index;
  }

  /** One budgeted line-of-sight test from the listener. Clear when the frame's budget is spent. */
  occlusionAt(position: Vector3): Occlusion {
    return this.budget.take() ? occlusionFor(this.blocked(position.x, position.y, position.z)) : CLEAR;
  }

  distanceTo(position: Vector3): number {
    return Math.hypot(position.x - this.listener.x, position.y - this.listener.y, position.z - this.listener.z);
  }

  /** A handle for callers outside the engine and for loops. */
  handle(index: number): SoundHandle {
    if (index < 0) return SILENT_HANDLE;
    const slot = this.slots[index]!;
    const generation = slot.generation;
    return {
      stop: (fadeSeconds = STEAL_FADE) => {
        if (slot.generation === generation && slot.source) this.stop(index, fadeSeconds);
      },
      setVolume: (volume: number) => {
        if (slot.generation !== generation || !slot.source) return;
        const scale = slot.volume > 0 ? volume / slot.volume : 0;
        slot.volume = volume;
        const gain = slot.gain.gain;
        gain.setTargetAtTime(gain.value * scale, this.graph.now, 0.05);
      },
    };
  }

  stop(index: number, fadeSeconds = STEAL_FADE): void {
    const slot = this.slots[index];
    if (!slot?.source) return;
    this.book.release(index, this.graph.now, fadeSeconds + 0.01);
    this.silence(index, fadeSeconds);
  }

  /** Stop every voice, or only the one-shots (loops keep running muted while paused). */
  stopAll(fadeSeconds: number, includeLoops: boolean): void {
    for (let i = 0; i < this.slots.length; i++) {
      if (!this.slots[i]!.source) continue;
      if (!includeLoops && this.book.voices[i]!.loop) continue;
      this.stop(i, fadeSeconds);
    }
  }

  get playing(): number {
    return this.book.playing;
  }

  get hrtfCount(): number {
    let count = 0;
    for (const voice of this.book.voices) if (voice.active && voice.hrtf) count++;
    return count;
  }

  /** Per-frame work: reset the raycast budget and keep positional loops matched to the listener. */
  update(dt: number): void {
    this.budget.reset();
    const now = this.graph.now;
    for (let i = 0; i < this.slots.length; i++) {
      const voice = this.book.voices[i]!;
      if (!voice.active || !voice.loop || !voice.positional) continue;
      const slot = this.slots[i]!;
      slot.refreshIn -= dt;
      if (slot.refreshIn > 0) continue;
      slot.refreshIn = LOOP_REFRESH;
      const distance = Math.hypot(slot.x - this.listener.x, slot.y - this.listener.y, slot.z - this.listener.z);
      voice.distance = distance;
      // Skip the ray for loops too far away to hear.
      if (distance < slot.profile.max && this.budget.take()) slot.occlusion = this.blocked(slot.x, slot.y, slot.z) ? 0 : 1;
      const occlusion = occlusionFor(slot.occlusion === 0);
      slot.gain.gain.setTargetAtTime(slot.volume * distanceGain(distance, slot.profile) * occlusion.gain, now, 0.18);
      slot.filter.frequency.setTargetAtTime(Math.min(slot.cutoff, finalCutoff(distance, slot.profile, occlusion)), now, 0.18);
    }
  }

  private blocked(x: number, y: number, z: number): boolean {
    this.from.set(this.listener.x, this.listener.y, this.listener.z);
    this.to.set(x, y, z);
    return !this.world().lineOfSight(this.from, this.to);
  }

  /** Give HRTF to the nearest and newest positional voices; the rest use equal-power panning. */
  private refreshHrtf(): void {
    for (const index of this.book.assignHrtf(this.hrtfEnabled ? MAX_HRTF : 0, this.changed)) {
      this.slots[index]!.panner.panningModel = this.book.voices[index]!.hrtf ? 'HRTF' : 'equalpower';
    }
  }

  private route(slot: Slot, bus: BusName, usesPanner: boolean): void {
    if (slot.usesPanner !== usesPanner) {
      if (slot.usesPanner !== null) slot.gain.disconnect(slot.usesPanner ? slot.panner : slot.stereo);
      slot.gain.connect(usesPanner ? slot.panner : slot.stereo);
      slot.usesPanner = usesPanner;
    }
    if (slot.bus !== bus) {
      if (slot.bus !== null) slot.out.disconnect();
      slot.out.connect(this.graph.bus(bus));
      slot.bus = bus;
    }
  }

  /** Ramp a slot down and stop its source, without a click. */
  private silence(index: number, fadeSeconds: number): void {
    const slot = this.slots[index]!;
    const source = slot.source;
    if (!source) return;
    const now = this.graph.now;
    slot.generation++;
    slot.source = null;
    slot.gain.gain.cancelScheduledValues(now);
    slot.gain.gain.setTargetAtTime(0, now, fadeSeconds / 4);
    slot.send.gain.setTargetAtTime(0, now, fadeSeconds / 4);
    source.onended = () => source.disconnect();
    try {
      source.stop(now + fadeSeconds);
    } catch {
      // Already stopped; nothing to do.
    }
  }
}
