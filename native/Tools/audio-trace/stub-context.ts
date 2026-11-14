/**
 * A recording stand-in for the Web Audio API, enough of it for src/audio to run in Node.
 *
 * Every AudioParam automation call, every buffer source start/stop and every panning-model or
 * convolver-buffer change is appended to one global log with a sequence number, so the trace
 * builder can attribute each call to the voice it belongs to. `AudioParam.value` reads evaluate
 * the automation timeline at `currentTime` with the Web Audio formulas (set, linear ramp,
 * exponential approach) and round to float32, as a browser's AudioParam does.
 *
 * Sources end deterministically: `advance(time)` fires `onended` for every source whose end
 * (natural end of its buffer or its stop time, whichever is first) is at or before `time`.
 * The Swift trace harness applies the same rule (IronvaleAudioTests/TraceHarness.swift).
 */

export type AutomationKind = 'set' | 'lin' | 'target' | 'cancel';

export interface Automation {
  readonly kind: AutomationKind;
  readonly time: number;
  readonly value: number;
  readonly tau: number;
}

export type LogEntry =
  | { readonly seq: number; readonly type: 'param'; readonly param: StubParam; readonly event: Automation }
  | { readonly seq: number; readonly type: 'value'; readonly param: StubParam; readonly value: number }
  | { readonly seq: number; readonly type: 'start'; readonly source: StubBufferSource }
  | { readonly seq: number; readonly type: 'stop'; readonly source: StubBufferSource; readonly when: number }
  | { readonly seq: number; readonly type: 'model'; readonly node: StubPanner; readonly model: string }
  | { readonly seq: number; readonly type: 'convolver'; readonly node: StubConvolver; readonly buffer: StubAudioBuffer | null };

export class Recorder {
  seq = 0;
  readonly log: LogEntry[] = [];
  readonly sources: StubBufferSource[] = [];
  context: StubAudioContext | null = null;

  push(entry: LogEntry extends infer E ? (E extends LogEntry ? Omit<E, 'seq'> : never) : never): void {
    this.log.push({ ...entry, seq: ++this.seq } as LogEntry);
  }
}

export let recorder = new Recorder();

export function resetRecorder(): Recorder {
  recorder = new Recorder();
  return recorder;
}

/** Value of an automation timeline at `t`, following the Web Audio event semantics. */
export function evaluateTimeline(defaultValue: number, events: readonly Automation[], t: number): number {
  let value = defaultValue;
  // Current segment: a constant, or an exponential approach that began at `segStart` from `segFrom`.
  let targeting = false;
  let segStart = 0;
  let segFrom = defaultValue;
  let segTarget = defaultValue;
  let segTau = 1;
  let prevTime = 0;
  const at = (time: number): number =>
    targeting ? segTarget + (segFrom - segTarget) * Math.exp(-(time - segStart) / segTau) : value;
  for (const event of events) {
    if (event.time > t) {
      if (event.kind === 'lin') {
        const from = at(prevTime);
        if (event.time === prevTime) return event.value;
        return from + ((event.value - from) * (t - prevTime)) / (event.time - prevTime);
      }
      return at(t);
    }
    const before = at(event.time);
    if (event.kind === 'target') {
      targeting = true;
      segStart = event.time;
      segFrom = before;
      segTarget = event.value;
      segTau = event.tau;
    } else {
      targeting = false;
      value = event.value;
    }
    prevTime = event.time;
  }
  return at(t);
}

export class StubParam {
  /** Name given by the trace builder once it knows what this param is. */
  label = '';
  readonly events: Automation[] = [];

  constructor(
    private readonly context: StubAudioContext,
    readonly defaultValue: number,
  ) {}

  get value(): number {
    return Math.fround(evaluateTimeline(this.defaultValue, this.events, this.context.currentTime));
  }

  set value(value: number) {
    // The setter behaves as setValueAtTime(value, currentTime).
    recorder.push({ type: 'value', param: this, value });
    this.insert({ kind: 'set', time: this.context.currentTime, value, tau: 0 });
  }

  setValueAtTime(value: number, time: number): this {
    return this.add({ kind: 'set', time, value, tau: 0 });
  }

  linearRampToValueAtTime(value: number, time: number): this {
    return this.add({ kind: 'lin', time, value, tau: 0 });
  }

  setTargetAtTime(value: number, time: number, tau: number): this {
    return this.add({ kind: 'target', time, value, tau });
  }

  cancelScheduledValues(time: number): this {
    recorder.push({ type: 'param', param: this, event: { kind: 'cancel', time, value: 0, tau: 0 } });
    for (let i = this.events.length - 1; i >= 0; i--) if (this.events[i]!.time >= time) this.events.splice(i, 1);
    return this;
  }

  private add(event: Automation): this {
    recorder.push({ type: 'param', param: this, event });
    this.insert(event);
    return this;
  }

  /** After every event at the same or an earlier time, before any later one. */
  private insert(event: Automation): void {
    let index = this.events.length;
    while (index > 0 && this.events[index - 1]!.time > event.time) index--;
    this.events.splice(index, 0, event);
  }
}

export class StubAudioBuffer {
  /** Asset id, when the buffer came from `decodeAudioData`. */
  soundId: string | null = null;
  private readonly channels: Float32Array[];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel]!;
  }
}

export class StubNode {
  readonly outputs: StubNode[] = [];
  constructor(readonly context: StubAudioContext) {}

  connect<T extends StubNode>(destination: T): T {
    this.outputs.push(destination);
    return destination;
  }

  disconnect(destination?: StubNode): void {
    if (!destination) {
      this.outputs.length = 0;
      return;
    }
    const index = this.outputs.indexOf(destination);
    if (index >= 0) this.outputs.splice(index, 1);
  }
}

export class StubGain extends StubNode {
  readonly gain: StubParam;
  constructor(context: StubAudioContext, options: { gain?: number } = {}) {
    super(context);
    this.gain = new StubParam(context, options.gain ?? 1);
  }
}

export class StubBiquad extends StubNode {
  readonly frequency: StubParam;
  readonly Q: StubParam;
  readonly type: string;
  constructor(context: StubAudioContext, options: { frequency?: number; Q?: number; type?: string } = {}) {
    super(context);
    this.frequency = new StubParam(context, options.frequency ?? 350);
    this.Q = new StubParam(context, options.Q ?? 1);
    this.type = options.type ?? 'lowpass';
  }
}

export class StubPanner extends StubNode {
  readonly positionX: StubParam;
  readonly positionY: StubParam;
  readonly positionZ: StubParam;
  private model: string;
  constructor(context: StubAudioContext, options: { panningModel?: string } = {}) {
    super(context);
    this.positionX = new StubParam(context, 0);
    this.positionY = new StubParam(context, 0);
    this.positionZ = new StubParam(context, 0);
    this.model = options.panningModel ?? 'equalpower';
  }

  get panningModel(): string {
    return this.model;
  }

  set panningModel(model: string) {
    this.model = model;
    recorder.push({ type: 'model', node: this, model });
  }
}

export class StubStereoPanner extends StubNode {
  readonly pan: StubParam;
  constructor(context: StubAudioContext, options: { pan?: number } = {}) {
    super(context);
    this.pan = new StubParam(context, options.pan ?? 0);
  }
}

export class StubConvolver extends StubNode {
  private current: StubAudioBuffer | null = null;
  get buffer(): StubAudioBuffer | null {
    return this.current;
  }
  set buffer(buffer: StubAudioBuffer | null) {
    this.current = buffer;
    recorder.push({ type: 'convolver', node: this, buffer });
  }
}

export class StubBufferSource extends StubNode {
  readonly buffer: StubAudioBuffer;
  readonly playbackRate: number;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  startWhen = -1;
  startOffset = 0;
  stopWhen: number | null = null;
  ended = false;
  /** What the source fed, and what that fed, when it started (sources disconnect once they end). */
  target: StubNode | null = null;
  targetDestination: StubNode | null = null;
  constructor(context: StubAudioContext, options: { buffer: StubAudioBuffer; playbackRate?: number; loop?: boolean; loopStart?: number; loopEnd?: number }) {
    super(context);
    this.buffer = options.buffer;
    this.playbackRate = options.playbackRate ?? 1;
    this.loop = options.loop ?? false;
    this.loopStart = options.loopStart ?? 0;
    this.loopEnd = options.loopEnd ?? 0;
  }

  start(when = 0, offset = 0): void {
    if (this.startWhen >= 0) throw new Error('start called twice');
    this.startWhen = when;
    this.startOffset = offset;
    this.target = this.outputs[0] ?? null;
    this.targetDestination = this.target?.outputs[0] ?? null;
    recorder.sources.push(this);
    recorder.push({ type: 'start', source: this });
  }

  stop(when = 0): void {
    if (this.startWhen < 0) throw new Error('stop before start');
    if (this.ended) throw new Error('stop after end');
    this.stopWhen = when;
    recorder.push({ type: 'stop', source: this, when });
  }

  /** When this source falls silent: the end of its buffer or its stop time, whichever comes first. */
  endTime(): number {
    const natural = this.loop
      ? Number.POSITIVE_INFINITY
      : this.startWhen + Math.max(0, this.buffer.duration - this.startOffset) / this.playbackRate;
    return Math.min(natural, this.stopWhen ?? Number.POSITIVE_INFINITY);
  }
}

class Inert extends StubNode {
  constructor(context: StubAudioContext, _options?: unknown) {
    super(context);
  }
  getFloatTimeDomainData(): void {}
}

export class StubAudioContext {
  currentTime = 0;
  readonly sampleRate = 48000;
  readonly state = 'running';
  readonly destination: StubNode;
  readonly listener: Record<'positionX' | 'positionY' | 'positionZ' | 'forwardX' | 'forwardY' | 'forwardZ' | 'upX' | 'upY' | 'upZ', StubParam>;
  /** Decoded length in seconds per sound id, from the scene fixture. */
  static durations: ReadonlyMap<string, number> = new Map();

  constructor(_options?: unknown) {
    this.destination = new Inert(this);
    const param = (value: number) => new StubParam(this, value);
    this.listener = {
      positionX: param(0), positionY: param(0), positionZ: param(0),
      forwardX: param(0), forwardY: param(0), forwardZ: param(-1),
      upX: param(0), upY: param(1), upZ: param(0),
    };
    recorder.context = this;
  }

  createBuffer(channels: number, length: number, rate: number): StubAudioBuffer {
    return new StubAudioBuffer(channels, length, rate);
  }

  decodeAudioData(data: ArrayBuffer): Promise<StubAudioBuffer> {
    const id = new TextDecoder().decode(data);
    const seconds = StubAudioContext.durations.get(id);
    if (seconds === undefined) return Promise.reject(new Error(`no duration for ${id}`));
    const buffer = new StubAudioBuffer(1, Math.round(seconds * this.sampleRate), this.sampleRate);
    // A full-scale first sample: the onset scan finds the sound starting at once.
    if (buffer.length > 0) buffer.getChannelData(0)[0] = 1;
    buffer.soundId = id;
    return Promise.resolve(buffer);
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }

  /** Move the clock and fire `onended` for every source that has fallen silent by then, earliest first. */
  advance(time: number): StubBufferSource[] {
    this.currentTime = time;
    const due = recorder.sources
      .filter((source) => !source.ended && source.endTime() <= time)
      .sort((a, b) => a.endTime() - b.endTime() || recorder.sources.indexOf(a) - recorder.sources.indexOf(b));
    for (const source of due) {
      source.ended = true;
      source.onended?.();
    }
    return due;
  }
}

/** Install the stand-ins as globals, as a browser would provide them. */
export function installWebAudio(): void {
  const g = globalThis as Record<string, unknown>;
  g.AudioContext = StubAudioContext;
  g.GainNode = StubGain;
  g.BiquadFilterNode = StubBiquad;
  g.PannerNode = StubPanner;
  g.StereoPannerNode = StubStereoPanner;
  g.ConvolverNode = StubConvolver;
  g.AudioBufferSourceNode = StubBufferSource;
  g.DynamicsCompressorNode = Inert;
  g.WaveShaperNode = Inert;
  g.ChannelSplitterNode = Inert;
  g.AnalyserNode = Inert;
  g.window = { addEventListener() {}, removeEventListener() {} };
  g.document = { addEventListener() {}, removeEventListener() {}, hidden: false };
}
