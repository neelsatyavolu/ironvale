/**
 * Spatial audio engine. One AudioContext, created when audio is unlocked from
 * a user gesture. Subscribes to the game's event bus for everything that makes
 * a sound; other systems only need `play` and `playAt`.
 *
 * Files: graph.ts (buses, limiter, reverb), pool.ts (voices), gunfire.ts and
 * foley.ts (event handlers), ambience.ts (beds and loops), catalog.ts (ids),
 * and the pure curves in curves.ts, layers.ts, voices.ts, variation.ts, impulse.ts.
 */
import { Vector3 } from 'three/webgpu';
import type { AudioSystem, GameContext, GameEvents, PlaySoundOptions, SoundHandle } from '../game/contracts';
import type { MapInstance, ReverbPreset } from '../world/types';
import { Ambience } from './ambience';
import { Catalog, INTERFACE_PREFIX } from './catalog';
import { PROFILES } from './curves';
import { createDebug, type AudioDebug } from './debug';
import { Foley } from './foley';
import { AudioGraph, SUB_BUFFER } from './graph';
import { Gunfire } from './gunfire';
import { activeReverb } from './layers';
import { Mixer } from './mixer';
import { SILENT_HANDLE, VoicePool, type DecodedSound } from './pool';
import soundMeta from './sound-meta.json';
import { jitter } from './variation';

const LOOPS: Readonly<Record<string, { start: number; end: number }>> = soundMeta.loops;
/** Samples quieter than this at the head of a one-shot are encoder padding. */
const ONSET_LEVEL = 0.004;
const ONSET_SCAN_SECONDS = 0.12;
const PAUSE_FADE = 0.08;
const UNLOCK_EVENTS = ['pointerdown', 'keydown'] as const;

/** Everything that exists only once the AudioContext does. */
interface Live {
  readonly graph: AudioGraph;
  readonly pool: VoicePool;
  readonly mixer: Mixer;
  readonly gunfire: Gunfire;
  readonly foley: Foley;
  readonly ambience: Ambience;
  readonly debug: AudioDebug;
}

export interface AudioEngineSystem extends AudioSystem {
  /** Developer tap for scripted checks; null until audio is unlocked. */
  readonly debug: AudioDebug | null;
}

export function createAudio(ctx: GameContext): AudioEngineSystem {
  return new AudioEngine(ctx);
}

class AudioEngine implements AudioEngineSystem {
  private readonly catalog: Catalog;
  private readonly buffers = new Map<string, DecodedSound>();
  private readonly decoding = new Map<string, Promise<void>>();
  private readonly unsubscribe: (() => void)[] = [];
  private readonly forward = new Vector3();
  private readonly up = new Vector3();
  private live: Live | null = null;
  private starting: Promise<void> | null = null;
  private map: MapInstance | null = null;
  private ambienceFor: MapInstance | null = null;
  private baseReverb: ReverbPreset = 'open-field';
  private paused = false;
  private disposed = false;

  constructor(private readonly ctx: GameContext) {
    this.catalog = new Catalog(ctx.assets);
    this.subscribe();
    // Belt and braces: the interface calls `unlock`, but any first gesture will do.
    for (const type of UNLOCK_EVENTS) window.addEventListener(type, this.onGesture, { capture: true, passive: true });
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  get debug(): AudioDebug | null {
    return this.live?.debug ?? null;
  }

  unlock(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    let live: Live;
    try {
      live = this.live ?? this.createLive();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('This browser cannot play audio'));
    }
    // WebKit only honours `resume` called directly inside the gesture, so it goes first, before any await.
    const context = live.graph.context;
    const resumed = context.state === 'running' || document.hidden ? Promise.resolve() : context.resume();
    this.starting ??= this.loadFirstSounds();
    return Promise.all([resumed, this.starting]).then(() => undefined);
  }

  requiredSounds(map: MapInstance): readonly string[] {
    return this.catalog.required(map);
  }

  async enterMap(map: MapInstance): Promise<void> {
    this.map = map;
    this.baseReverb = map.reverb;
    this.paused = false;
    // Before the first gesture there is no context to decode with; `unlock` picks the map up later.
    if (!this.live) return;
    await this.beginMap(map);
  }

  leaveMap(): void {
    this.map = null;
    this.ambienceFor = null;
    const live = this.live;
    if (!live) return;
    live.ambience.stop();
    live.pool.stopAll(0.1, true);
    live.foley.reset();
  }

  playAt(soundId: string, position: Vector3, options?: PlaySoundOptions): SoundHandle {
    return this.playSound(soundId, position, options);
  }

  play(soundId: string, options?: PlaySoundOptions): SoundHandle {
    return this.playSound(soundId, null, options);
  }

  /** Set the outdoor reverb. Interior zones still take over while the player is under a roof. */
  setReverb(preset: ReverbPreset): void {
    this.baseReverb = preset;
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    const live = this.live;
    if (!live) return;
    live.graph.setWorldGain(paused ? 0 : 1, PAUSE_FADE);
    // One-shots end with the fade so nothing finishes its tail when play resumes; loops wait muted.
    if (paused) live.pool.stopAll(PAUSE_FADE, false);
  }

  update(dt: number): void {
    const live = this.live;
    if (!live) return;
    const { graph, pool, mixer } = live;
    const settings = this.ctx.settings.value.audio;
    graph.applySettings(settings);
    pool.hrtfEnabled = settings.hrtf;
    mixer.clock += dt;
    this.moveListener(live);

    const indoors = this.map !== null && this.ctx.player.indoors;
    mixer.environment = activeReverb(this.baseReverb, indoors, indoors ? this.zoneReverb() : null);
    graph.setReverb(mixer.environment);
    graph.update();
    pool.update(dt);
    live.gunfire.update();
    if (this.paused || this.ambienceFor === null) return;
    live.foley.update(dt);
    live.ambience.update(dt, pool.listener, indoors);
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.unsubscribe) off();
    for (const type of UNLOCK_EVENTS) window.removeEventListener(type, this.onGesture, { capture: true });
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.live?.ambience.stop();
    this.live?.graph.dispose();
    this.live = null;
  }

  // ---------------------------------------------------------------- startup

  private readonly onGesture = (): void => {
    for (const type of UNLOCK_EVENTS) window.removeEventListener(type, this.onGesture, { capture: true });
    void this.unlock().catch((error: unknown) => console.warn('Audio could not start', error));
  };

  private readonly onVisibility = (): void => {
    const context = this.live?.graph.context;
    if (!context) return;
    const task = document.hidden ? context.suspend() : context.resume();
    void task.catch((error: unknown) => console.warn('Audio could not follow the page visibility', error));
  };

  /** Build the context and everything that hangs off it. Synchronous so it can run inside a gesture. */
  private createLive(): Live {
    const graph = new AudioGraph();
    const pool = new VoicePool(graph, () => this.ctx.world, () => new Vector3());
    const mixer = new Mixer(this.ctx, graph, pool, this.catalog, this.buffers, Math.random);
    const ambience = new Ambience(graph, pool, this.catalog, (id) => this.buffers.get(id) ?? null, mixer.picker, Math.random);
    const sub = graph.makeSubBuffer();
    this.buffers.set(SUB_BUFFER, { buffer: sub, offset: 0, loopStart: 0, loopEnd: sub.duration });
    const live: Live = {
      graph, pool, mixer, ambience,
      gunfire: new Gunfire(mixer),
      foley: new Foley(mixer),
      debug: createDebug(graph, pool, () => this.ambienceFor !== null, () => [...this.buffers.keys()]),
    };
    this.live = live;
    graph.applySettings(this.ctx.settings.value.audio);
    if (this.paused) graph.setWorldGain(0, 0);
    return live;
  }

  /** Interface sounds first, then the map if one was entered before audio was unlocked. */
  private async loadFirstSounds(): Promise<void> {
    const menuSounds = this.catalog.interfaceIds();
    try {
      await this.ctx.assets.preload(menuSounds);
      await this.decode(menuSounds);
    } catch (error) {
      console.warn('Interface sounds could not be loaded', error);
    }
    if (this.map) await this.beginMap(this.map);
  }

  /** Decode what the map needs (once; buffers are kept across maps) and start its ambience. */
  private async beginMap(map: MapInstance): Promise<void> {
    const live = this.live;
    if (!live) return;
    const ids = this.catalog.required(map);
    try {
      // The game preloads these before `enterMap`; this covers a map entered before audio was unlocked.
      await this.ctx.assets.preload(ids);
    } catch (error) {
      console.warn('Some sounds could not be loaded', error);
    }
    await this.decode(ids);
    if (this.map !== map || this.live !== live || this.ambienceFor === map) return;
    this.ambienceFor = map;
    live.graph.setWorldGain(this.paused ? 0 : 1, PAUSE_FADE);
    live.ambience.start(map);
  }

  private async decode(ids: readonly string[]): Promise<void> {
    const context = this.live?.graph.context;
    if (!context) return;
    await Promise.all(ids.map((id) => this.decodeOne(context, id)));
  }

  private decodeOne(context: AudioContext, id: string): Promise<void> {
    if (this.buffers.has(id)) return Promise.resolve();
    const running = this.decoding.get(id);
    if (running) return running;
    const task = (async () => {
      try {
        // decodeAudioData detaches its input, and the asset cache must keep its copy.
        const buffer = await context.decodeAudioData(this.ctx.assets.sound(id).slice(0));
        this.buffers.set(id, describe(id, buffer));
      } catch (error) {
        console.warn(`Sound "${id}" could not be decoded`, error);
      } finally {
        this.decoding.delete(id);
      }
    })();
    this.decoding.set(id, task);
    return task;
  }

  // ---------------------------------------------------------------- per frame

  private moveListener(live: Live): void {
    const camera = this.ctx.engine.camera;
    const e = camera.matrixWorld.elements;
    const x = e[12]!;
    const y = e[13]!;
    const z = e[14]!;
    this.forward.set(-e[8]!, -e[9]!, -e[10]!).normalize();
    this.up.set(e[4]!, e[5]!, e[6]!).normalize();
    live.mixer.right.crossVectors(this.forward, this.up).normalize();
    live.pool.listener.x = x;
    live.pool.listener.y = y;
    live.pool.listener.z = z;

    const listener = live.graph.context.listener;
    if (listener.positionX) {
      listener.positionX.value = x;
      listener.positionY.value = y;
      listener.positionZ.value = z;
      listener.forwardX.value = this.forward.x;
      listener.forwardY.value = this.forward.y;
      listener.forwardZ.value = this.forward.z;
      listener.upX.value = this.up.x;
      listener.upY.value = this.up.y;
      listener.upZ.value = this.up.z;
    } else {
      // Older WebKit has only the method form.
      listener.setPosition(x, y, z);
      listener.setOrientation(this.forward.x, this.forward.y, this.forward.z, this.up.x, this.up.y, this.up.z);
    }
  }

  /** Reverb of the interior zone the listener stands in, if the map names one. */
  private zoneReverb(): ReverbPreset | null {
    const live = this.live;
    const map = this.map;
    if (!live || !map) return null;
    const { x, y, z } = live.pool.listener;
    for (const zone of map.interiors) {
      const { min, max } = zone.box;
      if (x >= min.x && x <= max.x && y >= min.y && y <= max.y && z >= min.z && z <= max.z) return zone.reverb;
    }
    return null;
  }

  // ---------------------------------------------------------------- public one-offs

  private playSound(soundId: string, position: Vector3 | null, options: PlaySoundOptions | undefined): SoundHandle {
    const live = this.live;
    if (!live || !this.catalog.has(soundId)) return SILENT_HANDLE;
    const menu = soundId.startsWith(INTERFACE_PREFIX);
    if (this.paused && !menu) return SILENT_HANDLE;
    const sound = this.buffers.get(soundId);
    if (!sound) {
      // Not decoded yet: warm it so the next call plays.
      void this.ctx.assets
        .preload([soundId])
        .then(() => this.decode([soundId]))
        .catch((error: unknown) => console.warn(`Sound "${soundId}" could not be loaded`, error));
      return SILENT_HANDLE;
    }
    const request = live.mixer.request.reset();
    request.sound = sound;
    request.bus = menu ? 'interface' : 'effects';
    request.position = position;
    request.volume = options?.volume ?? 1;
    request.pitch = (options?.pitch ?? 1) * (options?.pitchJitter ? jitter(Math.random, options.pitchJitter) : 1);
    request.loop = options?.loop ?? false;
    if (position && (options?.refDistance !== undefined || options?.maxDistance !== undefined)) {
      request.profile = {
        ...PROFILES.generic,
        ref: options.refDistance ?? PROFILES.generic.ref,
        max: options.maxDistance ?? PROFILES.generic.max,
      };
    }
    return live.pool.handle(live.pool.play(request));
  }

  // ---------------------------------------------------------------- events

  private subscribe(): void {
    const on = <K extends keyof GameEvents>(type: K, handler: (live: Live, event: GameEvents[K]) => void): void => {
      this.unsubscribe.push(
        this.ctx.events.on(type, (event) => {
          const live = this.live;
          if (live && !this.paused && this.ambienceFor !== null) handler(live, event);
        }),
      );
    };
    on('shotFired', (live, event) => live.gunfire.shot(event));
    on('nearMiss', (live, event) => live.gunfire.nearMiss(event));
    on('bulletImpact', (live, event) => live.gunfire.impact(event));
    on('combatantHit', (live, event) => live.gunfire.combatantHit(event));
    on('dryFire', (live, event) => live.gunfire.dryFire(event));
    on('weaponAction', (live, event) => live.foley.weaponAction(event));
    on('weaponSwitch', (live, event) => live.foley.weaponSwitch(event));
    on('casingLanded', (live, event) => live.foley.casingLanded(event));
    on('aimChanged', (live, event) => live.foley.aimChanged(event));
    on('footstep', (live, event) => live.foley.footstep(event));
    on('jumped', (live, event) => live.foley.jumped(event));
    on('landed', (live, event) => live.foley.landed(event));
    on('playerHurt', (live, event) => live.foley.playerHurt(event));
    on('died', (live, event) => live.foley.died(event));
    on('botCallout', (live, event) => live.foley.botCallout(event));
    // Match state arrives while paused and in menus too: it is what switches the heartbeat off.
    this.unsubscribe.push(this.ctx.events.on('matchState', (snapshot) => this.live?.foley.matchState(snapshot)));
  }
}

/** Work out where a decoded sound really starts, and its loop points if it is a loop. */
function describe(id: string, buffer: AudioBuffer): DecodedSound {
  const loop = LOOPS[id];
  if (loop) return { buffer, offset: loop.start, loopStart: loop.start, loopEnd: Math.min(loop.end, buffer.duration) };
  const data = buffer.getChannelData(0);
  const limit = Math.min(data.length, Math.floor(ONSET_SCAN_SECONDS * buffer.sampleRate));
  let first = 0;
  while (first < limit && Math.abs(data[first]!) < ONSET_LEVEL) first++;
  // Keep a millisecond of lead-in; a file that is silent for the whole scan starts at 0.
  const offset = first >= limit ? 0 : Math.max(0, first / buffer.sampleRate - 0.001);
  return { buffer, offset, loopStart: 0, loopEnd: buffer.duration };
}
