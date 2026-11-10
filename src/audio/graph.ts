/**
 * The fixed part of the Web Audio graph: buses, the master limiter, the two
 * convolver slots that crossfade between reverb presets, and the analyser tap.
 *
 *   voices ──> effects ─┐
 *   beds ──> bedFilter ─┤                      ┌─> tap (L/R analysers)
 *   loops ─> duck ─> ambience ─> world ─> mix ─┼─> master ─> limiter ─> trim ─> clip ─> out
 *   reverb return ─> effects        interface ─┘
 */
import { hashString, seededRandom } from '../core/random';
import type { AudioSettings } from '../core/settings';
import type { ReverbPreset } from '../world/types';
import { generateImpulse } from './impulse';

export type BusName = 'effects' | 'ambience' | 'interface';

const PRESETS: readonly ReverbPreset[] = ['open-field', 'forest', 'street', 'industrial', 'interior'];
const REVERB_FADE = 0.7;
const SMOOTH = 0.05;
/** Chrome and Safari add make-up gain in the compressor; this takes it back so the limiter cannot push past full scale. */
const LIMITER_TRIM = 0.82;
const TAP_SIZE = 32768;
export const SUB_BUFFER = 'proc-sub';

interface ReverbSlot {
  readonly convolver: ConvolverNode;
  readonly gain: GainNode;
}

export class AudioGraph {
  readonly context: AudioContext;
  readonly effects: GainNode;
  readonly interface: GainNode;
  /** Positional ambience loops enter here: ducked under gunfire, not filtered indoors (occlusion does that). */
  readonly ambienceLoops: GainNode;
  /** Stereo beds enter here: low-passed when the player is under a roof. */
  readonly bedFilter: BiquadFilterNode;
  readonly reverbIn: GainNode;
  readonly tapLeft: AnalyserNode;
  readonly tapRight: AnalyserNode;

  private readonly master: GainNode;
  private readonly world: GainNode;
  private readonly mix: BiquadFilterNode;
  private readonly ambience: GainNode;
  private readonly duck: GainNode;
  private readonly impulses = new Map<ReverbPreset, AudioBuffer>();
  private readonly slots: [ReverbSlot, ReverbSlot];
  private activeSlot = 0;
  private reverb: ReverbPreset | null = null;
  private pendingReverb: ReverbPreset | null = null;
  private reverbBusyUntil = 0;
  private applied: AudioSettings | null = null;

  constructor() {
    const context = new AudioContext({ latencyHint: 'interactive' });
    this.context = context;

    const limiter = new DynamicsCompressorNode(context, { threshold: -8, knee: 4, ratio: 20, attack: 0.002, release: 0.14 });
    const trim = new GainNode(context, { gain: LIMITER_TRIM });
    // Last line of defence: linear to 0.85, then eased so nothing can leave above full scale.
    const clip = new WaveShaperNode(context, { curve: softClipCurve(), oversample: 'none' });
    this.master = new GainNode(context, { gain: 0 });
    this.master.connect(limiter).connect(trim).connect(clip).connect(context.destination);

    const splitter = new ChannelSplitterNode(context, { numberOfOutputs: 2 });
    this.tapLeft = new AnalyserNode(context, { fftSize: TAP_SIZE, smoothingTimeConstant: 0 });
    this.tapRight = new AnalyserNode(context, { fftSize: TAP_SIZE, smoothingTimeConstant: 0 });
    clip.connect(splitter);
    splitter.connect(this.tapLeft, 0);
    splitter.connect(this.tapRight, 1);

    this.mix = new BiquadFilterNode(context, { type: 'lowpass', frequency: 20000, Q: 0.5 });
    this.world = new GainNode(context, { gain: 1 });
    this.world.connect(this.mix).connect(this.master);

    this.effects = new GainNode(context, { gain: 1 });
    this.effects.connect(this.world);
    this.interface = new GainNode(context, { gain: 1 });
    this.interface.connect(this.master);

    this.ambience = new GainNode(context, { gain: 1 });
    this.duck = new GainNode(context, { gain: 1 });
    this.bedFilter = new BiquadFilterNode(context, { type: 'lowpass', frequency: 20000, Q: 0.5 });
    this.ambienceLoops = new GainNode(context, { gain: 1 });
    this.bedFilter.connect(this.duck);
    this.ambienceLoops.connect(this.duck);
    this.duck.connect(this.ambience).connect(this.world);

    this.reverbIn = new GainNode(context, { gain: 1 });
    const makeSlot = (): ReverbSlot => {
      const convolver = new ConvolverNode(context, { disableNormalization: true });
      const gain = new GainNode(context, { gain: 0 });
      this.reverbIn.connect(convolver).connect(gain).connect(this.effects);
      return { convolver, gain };
    };
    this.slots = [makeSlot(), makeSlot()];

    for (const preset of PRESETS) {
      const [left, right] = generateImpulse(preset, context.sampleRate, seededRandom(hashString(preset)));
      const buffer = context.createBuffer(2, left.length, context.sampleRate);
      buffer.getChannelData(0).set(left);
      buffer.getChannelData(1).set(right);
      this.impulses.set(preset, buffer);
    }
  }

  get now(): number {
    return this.context.currentTime;
  }

  /** Follow the volume sliders. Cheap to call every frame: it only acts on a change. */
  applySettings(settings: AudioSettings): void {
    if (settings === this.applied) return;
    this.applied = settings;
    const now = this.now;
    this.master.gain.setTargetAtTime(settings.master, now, SMOOTH);
    this.effects.gain.setTargetAtTime(settings.effects, now, SMOOTH);
    this.ambience.gain.setTargetAtTime(settings.ambience, now, SMOOTH);
    this.interface.gain.setTargetAtTime(settings.interface, now, SMOOTH);
  }

  bus(name: BusName): AudioNode {
    return name === 'interface' ? this.interface : name === 'ambience' ? this.ambienceLoops : this.effects;
  }

  /** Crossfade to another reverb. A change that arrives mid-fade waits for the idle slot. */
  setReverb(preset: ReverbPreset): void {
    if (preset === this.reverb) {
      this.pendingReverb = null;
      return;
    }
    if (this.now < this.reverbBusyUntil) {
      this.pendingReverb = preset;
      return;
    }
    const buffer = this.impulses.get(preset);
    if (!buffer) return;
    const now = this.now;
    const next = this.slots[1 - this.activeSlot]!;
    const previous = this.slots[this.activeSlot]!;
    next.convolver.buffer = buffer;
    fadeTo(next.gain.gain, 1, now, REVERB_FADE);
    fadeTo(previous.gain.gain, 0, now, REVERB_FADE);
    this.activeSlot = 1 - this.activeSlot;
    this.reverb = preset;
    this.pendingReverb = null;
    this.reverbBusyUntil = now + REVERB_FADE + 0.05;
  }

  /** Call once a frame: applies a reverb change queued during a fade and rests the faded-out convolver. */
  update(): void {
    if (this.now < this.reverbBusyUntil) return;
    const idle = this.slots[1 - this.activeSlot]!;
    // A convolver with no impulse costs nothing; the silent one would otherwise keep computing.
    if (idle.convolver.buffer) idle.convolver.buffer = null;
    if (this.pendingReverb) this.setReverb(this.pendingReverb);
  }

  /** Dip ambience under a gunshot and let it swell back. `depth` is the gain at the bottom. */
  duckAmbience(depth: number, hold: number, release: number): void {
    const now = this.now;
    const gain = this.duck.gain;
    gain.cancelScheduledValues(now);
    gain.setTargetAtTime(depth, now, 0.012);
    gain.setTargetAtTime(1, now + hold, release);
  }

  /** Under a roof the outside world loses its top end and some level. */
  setIndoors(indoors: boolean): void {
    this.bedFilter.frequency.setTargetAtTime(indoors ? 1100 : 20000, this.now, 0.35);
  }

  /** 0 is a normal mix; 1 closes the world down to a dull murmur (low health). */
  setNarrow(amount: number): void {
    const cutoff = 20000 * (900 / 20000) ** Math.min(1, Math.max(0, amount));
    this.mix.frequency.setTargetAtTime(cutoff, this.now, 0.25);
  }

  /** Mute or restore everything in the world; the interface bus keeps playing. */
  setWorldGain(value: number, seconds: number): void {
    fadeTo(this.world.gain, value, this.now, seconds);
  }

  /** A short sine drop for the chest thump under the player's own shots. */
  makeSubBuffer(): AudioBuffer {
    const rate = this.context.sampleRate;
    const length = Math.floor(0.24 * rate);
    const buffer = this.context.createBuffer(1, length, rate);
    const data = buffer.getChannelData(0);
    let phase = 0;
    for (let i = 0; i < length; i++) {
      const t = i / rate;
      phase += (2 * Math.PI * (38 + 62 * Math.exp(-t / 0.035))) / rate;
      data[i] = Math.sin(phase) * Math.min(1, t / 0.003) * Math.exp(-t / 0.06) * Math.min(1, (length - i) / (0.02 * rate));
    }
    return buffer;
  }

  dispose(): void {
    void this.context.close().catch(() => undefined);
  }
}

function fadeTo(param: AudioParam, value: number, now: number, seconds: number): void {
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(value, now + seconds);
}

function softClipCurve(): Float32Array<ArrayBuffer> {
  const size = 2049;
  const curve = new Float32Array(size);
  const knee = 0.85;
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    const magnitude = Math.abs(x);
    // Above the knee the curve bends toward 0.98 and never passes it.
    const shaped = magnitude <= knee ? magnitude : knee + (0.98 - knee) * Math.tanh((magnitude - knee) / (0.98 - knee));
    curve[i] = Math.sign(x) * shaped;
  }
  return curve;
}
