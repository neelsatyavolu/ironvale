/**
 * M8a audio trace exporter (PLAN.md section 7). Drives the web's src/audio engine, unchanged,
 * through the 20 scripted scenes in scenes.ts against the recording stub AudioContext in
 * stub-context.ts, and writes per-voice parameter traces the native IronvaleAudio must match.
 *
 *   npx vitest run --config native/Tools/audio-trace/vitest.config.ts
 *
 * Outputs (committed; native/ci/check-m8a.sh regenerates them and fails on drift):
 *   native/Tools/audio-trace/fixtures/sounds.json         decoded length of every sound (from the MP3 frames)
 *   native/Tools/audio-trace/fixtures/scenes/<name>.json  scene inputs and the web's trace
 *
 * Math.random is replaced by mulberry32(scene.seed) for the run, so the web's variation picks,
 * jitter and ambience timing are reproducible; the native engine takes the same stream.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Vector3 } from 'three/webgpu';
import { expect, it } from 'vitest';
import { Assets } from '../../../src/core/assets';
import { EventBus } from '../../../src/core/events';
import { seededRandom } from '../../../src/core/random';
import { createAudio } from '../../../src/audio/index';
import { PlayRequest, VoicePool } from '../../../src/audio/pool';
import { mp3Length } from './mp3';
import { buildScenes, MAPS, type Action, type Scene, type SceneMap, type SceneSettings, type Vec } from './scenes';
import {
  installWebAudio,
  resetRecorder,
  StubAudioContext,
  type Automation,
  type LogEntry,
  type Recorder,
  type StubBufferSource,
  type StubParam,
} from './stub-context';

const out = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const REPO = out('../../../');
const FIXTURES = out('./fixtures/');
const RATE = 48000;

type Compact = [string, number, number, number];

interface PlayWindow {
  readonly from: number;
  to: number;
  slot: number;
  frame: number;
  positional: boolean;
  bus: string;
  occlusion: number;
  position: Vec | null;
  pan: number;
}

interface VoiceTrace {
  frame: number;
  kind: 'voice' | 'bed';
  slot: number;
  sound: string;
  bus: string;
  start: number;
  offset: number;
  rate: number;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  positional: boolean;
  position: Vec | null;
  pan: number;
  occlusion: number;
  hrtf: boolean[];
  gain: Compact[];
  cutoff: Compact[];
  send: Compact[];
  stop: number | null;
  end: number | null;
  endFrame: number | null;
}

// ---------------------------------------------------------------- sound lengths

function soundLengths(assets: Assets): Record<string, number> {
  const manifest = JSON.parse(readFileSync(`${REPO}assets/sounds.json`, 'utf8')) as { assets: { id: string; files: { audio: { path: string } } }[] };
  const paths = new Map(manifest.assets.map((entry) => [entry.id, entry.files.audio.path]));
  const lengths: Record<string, number> = {};
  for (const id of assets.idsWithPrefix('snd-').sort()) {
    const path = paths.get(id);
    if (!path) throw new Error(`no file for ${id}`);
    const { samples, sampleRate } = mp3Length(new Uint8Array(readFileSync(`${REPO}public/assets/local/${path}`)));
    lengths[id] = Math.round((samples * RATE) / sampleRate);
  }
  return lengths;
}

// ---------------------------------------------------------------- one scene

const v3 = (v: Vec): Vector3 => new Vector3(v[0], v[1], v[2]);
const compact = (a: Automation): Compact => [a.kind, a.time, a.value, a.tau];

function mapInstance(map: SceneMap): unknown {
  return {
    reverb: map.reverb,
    weather: map.weather,
    ambience: map.ambience.map((layer) => ({ ...layer, position: layer.position ? v3(layer.position) : undefined })),
    interiors: map.interiors.map((zone) => ({ reverb: zone.reverb, box: { min: v3(zone.min), max: v3(zone.max) } })),
  };
}

/** Segment-box overlap, slab method: the stand-in for World.lineOfSight. */
function segmentHitsBox(a: Vector3, b: Vector3, box: { min: Vec; max: Vec }): boolean {
  let t0 = 0;
  let t1 = 1;
  const from = [a.x, a.y, a.z];
  const to = [b.x, b.y, b.z];
  for (let axis = 0; axis < 3; axis++) {
    const d = to[axis]! - from[axis]!;
    if (d === 0) {
      if (from[axis]! < box.min[axis]! || from[axis]! > box.max[axis]!) return false;
      continue;
    }
    let near = (box.min[axis]! - from[axis]!) / d;
    let far = (box.max[axis]! - from[axis]!) / d;
    if (near > far) [near, far] = [far, near];
    t0 = Math.max(t0, near);
    t1 = Math.min(t1, far);
    if (t0 > t1) return false;
  }
  return true;
}

/** Equal-power panner azimuth (Web Audio spec, PannerNode "azimuth and elevation"), folded to [-90, 90] and divided by 90. */
function equalPowerPan(listener: number[], source: Vec): number {
  const [px, py, pz, fx, fy, fz, ux, uy, uz] = listener as [number, number, number, number, number, number, number, number, number];
  const norm = (x: number, y: number, z: number): [number, number, number] => {
    const l = Math.hypot(x, y, z);
    return l === 0 ? [0, 0, 0] : [x / l, y / l, z / l];
  };
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const cross = (a: number[], b: number[]): [number, number, number] => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  const s = norm(source[0] - px, source[1] - py, source[2] - pz);
  if (s[0] === 0 && s[1] === 0 && s[2] === 0) return 0;
  const forward = norm(fx, fy, fz);
  const right = norm(...cross(forward, [ux, uy, uz]));
  const up = cross(right, forward);
  const upProjection = dot(s, up);
  const projected = norm(s[0] - upProjection * up[0], s[1] - upProjection * up[1], s[2] - upProjection * up[2]);
  let azimuth = (180 / Math.PI) * Math.acos(Math.max(-1, Math.min(1, dot(projected, right))));
  if (dot(projected, forward) < 0) azimuth = 360 - azimuth;
  azimuth = azimuth >= 0 && azimuth <= 270 ? 90 - azimuth : 450 - azimuth;
  if (azimuth < -90) azimuth = -180 - azimuth;
  else if (azimuth > 90) azimuth = 180 - azimuth;
  return azimuth / 90;
}

let windows: PlayWindow[] = [];
let currentFrame = -1;
let rec: Recorder;
let lastListener: () => number[] = () => [];

// Wrap the web's VoicePool.play (not edited) to learn which slot each play call used.
const webPlay = VoicePool.prototype.play;
VoicePool.prototype.play = function play(this: VoicePool, request: PlayRequest): number {
  const position: Vec | null = request.position ? [request.position.x, request.position.y, request.position.z] : null;
  const pan = request.pan;
  const window: PlayWindow = { from: rec.seq, to: 0, slot: -1, frame: currentFrame, positional: false, bus: '', occlusion: 1, position, pan };
  const slot = webPlay.call(this, request);
  window.to = rec.seq;
  window.slot = slot;
  if (slot >= 0) {
    const s = (this as unknown as { slots: { bus: string; usesPanner: boolean; occlusion: number }[] }).slots[slot]!;
    window.bus = s.bus;
    window.positional = s.usesPanner;
    window.occlusion = s.occlusion;
    if (position) window.pan = equalPowerPan(lastListener(), position);
  }
  windows.push(window);
  return slot;
};

async function runScene(scene: Scene, lengths: Record<string, number>, assets: Assets): Promise<unknown> {
  rec = resetRecorder();
  windows = [];
  frameSeqs = [];
  currentFrame = -1;
  StubAudioContext.durations = new Map(Object.entries(lengths).map(([id, n]) => [id, n / RATE]));
  const random = seededRandom(scene.seed);
  const savedRandom = Math.random;
  Math.random = random;

  const toSettings = (s: SceneSettings) => ({
    audio: { master: s.master, effects: s.effects, ambience: s.ambience, interface: s.interface, hrtf: s.hrtf },
    gameplay: { showHitMarkers: s.showHitMarkers },
  });
  const rays: [Vec, Vec, boolean][] = [];
  let combatants = scene.combatants;
  const camera = { matrixWorld: { elements: scene.frames[0]?.camera ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.6, 0, 1] } };
  const player = { id: scene.playerId, indoors: false, crouching: false };
  const ctx = {
    assets: {
      idsWithPrefix: (prefix: string) => assets.idsWithPrefix(prefix),
      preload: () => Promise.resolve(),
      sound: (id: string) => new TextEncoder().encode(id).buffer,
    },
    events: new EventBus<Record<string, unknown>>(),
    settings: { value: toSettings(scene.settings) },
    engine: { camera },
    player,
    combat: {
      get: (id: number) => {
        const c = combatants[String(id)];
        return c ? { position: v3(c.position), crouching: c.crouching } : undefined;
      },
    },
    world: {
      lineOfSight: (from: Vector3, to: Vector3) => {
        const clear = !scene.occluders.some((box) => segmentHitsBox(from, to, box));
        rays.push([[from.x, from.y, from.z], [to.x, to.y, to.z], clear]);
        return clear;
      },
    },
  };

  // The listener of this scene's context (it exists once the engine creates its graph).
  lastListener = () => {
    const listener = rec.context!.listener;
    return (['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ'] as const).map((key) => {
      const events = listener[key].events;
      return events.length ? events[events.length - 1]!.value : listener[key].defaultValue;
    });
  };
  const engine = createAudio(ctx as never);
  const handles = new Map<string, { stop(fade?: number): void; setVolume(v: number): void }>();
  try {
    await engine.enterMap(mapInstance(scene.map) as never);
    await engine.unlock();
    const live = (engine as unknown as { live: { graph: Record<string, unknown>; pool: unknown } }).live;
    const context = live.graph.context as StubAudioContext;
    const endFrames = new Map<StubBufferSource, number>();
    for (const [index, frame] of scene.frames.entries()) {
      currentFrame = index;
      frameSeqs.push(rec.seq);
      for (const source of context.advance(frame.time)) endFrames.set(source, index);
      camera.matrixWorld.elements = frame.camera;
      player.indoors = frame.indoors;
      player.crouching = frame.crouching;
      if (frame.settings) ctx.settings.value = toSettings(frame.settings);
      if (frame.combatants) combatants = frame.combatants;
      for (const action of frame.actions) await perform(engine, ctx, action, handles);
      engine.update(frame.dt);
    }
    return { scene, maps: MAPS, trace: buildTrace(live, endFrames, rays) };
  } finally {
    engine.dispose();
    Math.random = savedRandom;
  }
}

async function perform(
  engine: ReturnType<typeof createAudio>,
  ctx: { events: EventBus<Record<string, unknown>> },
  action: Action,
  handles: Map<string, { stop(fade?: number): void; setVolume(v: number): void }>,
): Promise<void> {
  switch (action.op) {
    case 'event': {
      const { op: _op, type, ...payload } = action;
      ctx.events.emit(type as string, revive(payload));
      return;
    }
    case 'play':
    case 'playAt': {
      const options = action.options as Record<string, unknown> | undefined;
      const handle =
        action.op === 'play'
          ? engine.play(action.id as string, options)
          : engine.playAt(action.id as string, v3(action.position as Vec), options);
      if (action.handle) handles.set(action.handle as string, handle);
      return;
    }
    case 'handleStop':
      if (action.fade === undefined) handles.get(action.handle as string)!.stop();
      else handles.get(action.handle as string)!.stop(action.fade as number);
      return;
    case 'handleVolume':
      handles.get(action.handle as string)!.setVolume(action.volume as number);
      return;
    case 'pause':
      engine.setPaused(action.paused as boolean);
      return;
    case 'reverb':
      engine.setReverb(action.preset as never);
      return;
    case 'leaveMap':
      engine.leaveMap();
      return;
    case 'enterMap':
      await engine.enterMap(mapInstance(MAPS[action.map as string]!) as never);
      return;
    default:
      throw new Error(`unknown action ${action.op}`);
  }
}

/** Event payloads carry vectors as arrays; the handlers expect Vector3s. */
function revive(value: unknown, key = ''): unknown {
  if (Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number') && key !== 'camera') return v3(value as Vec);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'weapon' ? v : revive(v, k)]));
  return value;
}

// ---------------------------------------------------------------- trace

function buildTrace(live: { graph: Record<string, unknown>; pool: unknown }, endFrames: Map<StubBufferSource, number>, rays: [Vec, Vec, boolean][]): unknown {
  const graph = live.graph as Record<string, { gain?: StubParam; frequency?: StubParam }> & { slots: { gain: { gain: StubParam }; convolver: unknown }[]; impulses: Map<string, unknown> };
  const busParams: Record<string, StubParam> = {
    master: graph.master!.gain!,
    world: graph.world!.gain!,
    mix: graph.mix!.frequency!,
    ambience: graph.ambience!.gain!,
    duck: graph.duck!.gain!,
    effects: graph.effects!.gain!,
    interface: graph.interface!.gain!,
    bedFilter: graph.bedFilter!.frequency!,
    ambienceLoops: graph.ambienceLoops!.gain!,
    reverbIn: graph.reverbIn!.gain!,
    reverb0: graph.slots[0]!.gain.gain,
    reverb1: graph.slots[1]!.gain.gain,
  };
  const slots = (live.pool as { slots: { filter: { frequency: StubParam }; gain: { gain: StubParam }; send: { gain: StubParam }; panner: unknown }[] }).slots;
  const slotOf = new Map<unknown, { slot: number; field: 'gain' | 'cutoff' | 'send' }>();
  slots.forEach((s, i) => {
    slotOf.set(s.filter.frequency, { slot: i, field: 'cutoff' });
    slotOf.set(s.gain.gain, { slot: i, field: 'gain' });
    slotOf.set(s.send.gain, { slot: i, field: 'send' });
  });
  const pannerSlot = new Map(slots.map((s, i) => [s.panner, i]));
  const filterSlot = new Map(slots.map((s, i) => [s.filter, i]));
  const presetOf = new Map([...graph.impulses.entries()].map(([preset, buffer]) => [buffer, preset]));
  const convolverSlot = new Map(graph.slots.map((s, i) => [s.convolver, i]));
  const soundOf = (source: StubBufferSource): string => {
    if (source.buffer.soundId) return source.buffer.soundId;
    if (source.buffer.numberOfChannels === 1 && source.buffer.length === Math.floor(0.24 * RATE)) return 'proc-sub';
    throw new Error('source with an unknown buffer');
  };

  const voices: VoiceTrace[] = [];
  const bySource = new Map<StubBufferSource, VoiceTrace>();
  const current = new Map<number, VoiceTrace>();
  const bedGain = new Map<unknown, VoiceTrace>();
  const busEvents: Record<string, Compact[]> = Object.fromEntries(Object.keys(busParams).map((k) => [k, []]));
  const busOf = new Map(Object.entries(busParams).map(([k, p]) => [p as unknown, k]));
  const reverb: [number, number, string | null][] = [];
  let beds = 0;
  // Gain params of bed sources (sources that feed a gain node rather than a pool slot).
  const bedPending = new Map<unknown, Compact[]>();
  for (const source of rec.sources) {
    const target = source.target;
    if (filterSlot.get(target as never) === undefined) bedPending.set((target as unknown as { gain: StubParam }).gain, []);
  }

  // The play window each log entry falls in, if any.
  let w = 0;
  const windowAt = (seq: number): PlayWindow | null => {
    while (w < windows.length && windows[w]!.to < seq) w++;
    const candidate = windows[w];
    return candidate && candidate.from < seq && seq <= candidate.to ? candidate : null;
  };
  // Entries on a play call's own slot belong to the voice that call starts (some come before the
  // source exists), and its panning model is whatever the call left it at. Both are applied when the call ends.
  let open: { window: PlayWindow; voice: VoiceTrace | null; params: { field: 'gain' | 'cutoff' | 'send'; entry: LogEntry }[]; model: string | null } | null = null;
  const closeWindow = (): void => {
    if (!open) return;
    for (const { field, entry } of open.params) apply(open.voice, field, entry);
    if (open.voice && open.model !== null) applyModel(open.voice, open.model);
    open = null;
  };
  const applyModel = (voice: VoiceTrace | null, model: string): void => {
    if (!voice) return;
    const hrtf = model === 'HRTF';
    if (voice.hrtf[voice.hrtf.length - 1] !== hrtf) voice.hrtf.push(hrtf);
  };
  const apply = (voice: VoiceTrace | null, field: 'gain' | 'cutoff' | 'send', entry: LogEntry): void => {
    if (voice && entry.type === 'param') voice[field].push(compact(entry.event));
  };

  for (const entry of rec.log) {
    const window = windowAt(entry.seq);
    if (open && window !== open.window) closeWindow();
    if (window && !open) open = { window, voice: null, params: [], model: null };
    if (entry.type === 'start') {
      const source = entry.source;
      const target = source.target;
      const slot = filterSlot.get(target as never);
      const sound = soundOf(source);
      if (slot === undefined) {
        const destination = source.targetDestination;
        const voice: VoiceTrace = {
          frame: currentFrameOf(entry.seq), kind: 'bed', slot: beds++, sound,
          bus: destination === graph.bedFilter ? 'bedFilter' : 'ambienceLoops',
          start: source.startWhen, offset: source.startOffset, rate: source.playbackRate, loop: source.loop,
          loopStart: source.loopStart, loopEnd: source.loopEnd, positional: false, position: null, pan: 0, occlusion: 1,
          hrtf: [], gain: [], cutoff: [], send: [], stop: null, end: null, endFrame: null,
        };
        // Its gain was automated before it started; those events were held for it.
        const gainParam = (target as unknown as { gain: StubParam }).gain;
        voice.gain = bedPending.get(gainParam) ?? [];
        bedGain.set(gainParam, voice);
        bySource.set(source, voice);
        voices.push(voice);
        continue;
      }
      if (!window || window.slot !== slot) throw new Error('voice started outside its play call');
      const voice: VoiceTrace = {
        frame: window.frame, kind: 'voice', slot, sound, bus: window.bus,
        start: source.startWhen, offset: source.startOffset, rate: source.playbackRate, loop: source.loop,
        loopStart: source.loopStart, loopEnd: source.loopEnd, positional: window.positional,
        position: window.positional ? window.position : null, pan: window.pan, occlusion: window.occlusion,
        hrtf: [], gain: [], cutoff: [], send: [], stop: null, end: null, endFrame: null,
      };
      current.set(slot, voice);
      bySource.set(source, voice);
      voices.push(voice);
      open!.voice = voice;
      continue;
    }
    if (entry.type === 'stop') {
      const voice = bySource.get(entry.source);
      if (voice) voice.stop = entry.when;
      continue;
    }
    if (entry.type === 'convolver') {
      reverb.push([currentFrameOf(entry.seq), convolverSlot.get(entry.node)!, entry.buffer ? (presetOf.get(entry.buffer) as string) : null]);
      continue;
    }
    if (entry.type === 'model') {
      const slot = pannerSlot.get(entry.node);
      if (slot === undefined) continue;
      if (open && open.window.slot === slot) open.model = entry.model;
      else applyModel(current.get(slot) ?? null, entry.model);
      continue;
    }
    // Param automation. `value` setter entries (panner position, stereo pan) are covered by the play window.
    if (entry.type !== 'param') continue;
    const bus = busOf.get(entry.param);
    if (bus) {
      busEvents[bus]!.push(compact(entry.event));
      continue;
    }
    const bed = bedGain.get(entry.param);
    if (bed) {
      bed.gain.push(compact(entry.event));
      continue;
    }
    const held = bedPending.get(entry.param);
    if (held) {
      held.push(compact(entry.event));
      continue;
    }
    const owner = slotOf.get(entry.param);
    if (!owner) continue;
    if (open && open.window.slot === owner.slot) open.params.push({ field: owner.field, entry });
    else apply(current.get(owner.slot) ?? null, owner.field, entry);
  }
  closeWindow();
  for (const [source, voice] of bySource) {
    if (source.ended) {
      voice.end = source.endTime();
      voice.endFrame = endFrames.get(source) ?? null;
    }
  }
  return { voices, buses: busEvents, reverb, rays };
}

/** Log sequence number at the start of each frame. */
let frameSeqs: number[] = [];
function currentFrameOf(seq: number): number {
  let frame = -1;
  while (frame + 1 < frameSeqs.length && frameSeqs[frame + 1]! < seq) frame++;
  return frame;
}

// ---------------------------------------------------------------- test entry

it('writes the M8a audio traces', async () => {
  installWebAudio();
  const assets = new Assets('1k' as never, 1);
  const lengths = soundLengths(assets);
  mkdirSync(`${FIXTURES}scenes`, { recursive: true });
  for (const file of readdirSync(`${FIXTURES}scenes`)) rmSync(`${FIXTURES}scenes/${file}`);
  writeFileSync(`${FIXTURES}sounds.json`, `${JSON.stringify({ sampleRate: RATE, lengths }, null, 1)}\n`);
  const scenes = buildScenes();
  expect(scenes).toHaveLength(20);
  for (const [index, scene] of scenes.entries()) {
    const result = (await runScene(scene, lengths, assets)) as { trace: { voices: unknown[] } };
    expect(result.trace.voices.length).toBeGreaterThan(0);
    const name = `${String(index + 1).padStart(2, '0')}-${scene.name}`;
    writeFileSync(`${FIXTURES}scenes/${name}.json`, `${JSON.stringify(result)}\n`);
  }
});
