/**
 * Map ambience: stereo beds that drift slowly in level, positional loops on
 * the pool, rain that changes character under a roof, and sparse one-shots
 * placed around the listener so the place does not feel like a loop.
 */
import { Vector3 } from 'three/webgpu';
import type { SoundHandle } from '../game/contracts';
import type { MapInstance } from '../world/types';
import { RAIN_BED, RAIN_ROOF_BED, type Catalog } from './catalog';
import { PROFILES, type DistanceProfile } from './curves';
import type { AudioGraph } from './graph';
import { PlayRequest, type DecodedSound, type VoicePool } from './pool';
import { jitter, type VariationPicker } from './variation';
import { PRIORITY } from './voices';

const DRIFT_LOW = 0.72;
const DRIFT_HIGH = 1.1;
const FADE_IN = 1.5;
const ONESHOT_MIN_GAP = 7;
const ONESHOT_MAX_GAP = 22;
/** One-shots are heard from far off: full level at 30 m, gone by 220 m. */
const FAR_PROFILE: DistanceProfile = { ...PROFILES.ambient, ref: 30, max: 220, airHalf: 90 };
/** How much of the outdoor rain bed is left under a roof. */
const RAIN_INDOOR_SHARE = 0.3;
const DEFAULT_RADIUS = 20;

interface Bed {
  readonly id: string;
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  readonly volume: number;
  /** Multiplier applied when indoors and outdoors. */
  readonly indoor: number;
  readonly outdoor: number;
  drift: number;
  driftIn: number;
}

export class Ambience {
  private beds: Bed[] = [];
  private loops: SoundHandle[] = [];
  private oneShots: string[] = [];
  private nextOneShot = 0;
  private indoors = false;
  private readonly request = new PlayRequest();
  private readonly position = new Vector3();

  constructor(
    private readonly graph: AudioGraph,
    private readonly pool: VoicePool,
    private readonly catalog: Catalog,
    private readonly sound: (id: string) => DecodedSound | null,
    private readonly picker: VariationPicker,
    private readonly random: () => number,
  ) {}

  start(map: MapInstance): void {
    this.stop();
    this.indoors = false;
    const volumes = new Map(map.ambience.filter((layer) => !layer.position).map((layer) => [layer.sound, layer.volume]));
    for (const id of this.catalog.bedIds(map)) {
      const volume = volumes.get(id) ?? 0.8;
      this.addBed(id, volume, id === RAIN_BED ? RAIN_INDOOR_SHARE : 1, 1, this.graph.bedFilter);
      // Rain heard from inside plays only under a roof and skips the indoor low-pass.
      if (id === RAIN_BED) this.addBed(RAIN_ROOF_BED, volume, 1, 0, this.graph.ambienceLoops);
    }
    for (const layer of map.ambience) {
      if (!layer.position) continue;
      const sound = this.sound(layer.sound);
      if (!sound) continue;
      // `radius` is how far the loop carries: full level inside a fifth of it, soft at its edge, gone at twice it.
      const radius = layer.radius ?? DEFAULT_RADIUS;
      const request = this.request.reset();
      request.sound = sound;
      request.bus = 'ambience';
      request.position = layer.position;
      request.profile = { ...PROFILES.ambient, ref: Math.max(1.5, radius * 0.2), max: radius * 2 };
      request.volume = layer.volume;
      request.loop = true;
      request.priority = PRIORITY.high;
      request.fadeIn = FADE_IN;
      this.loops.push(this.pool.handle(this.pool.play(request)));
    }
    this.oneShots = this.catalog.oneShotGroups(this.catalog.bedIds(map));
    this.nextOneShot = ONESHOT_MIN_GAP * (0.5 + this.random());
  }

  stop(): void {
    const now = this.graph.now;
    for (const bed of this.beds) {
      bed.gain.gain.cancelScheduledValues(now);
      bed.gain.gain.setTargetAtTime(0, now, 0.08);
      bed.source.stop(now + 0.5);
      bed.source.onended = () => {
        bed.source.disconnect();
        bed.gain.disconnect();
      };
    }
    for (const loop of this.loops) loop.stop(0.3);
    this.beds = [];
    this.loops = [];
    this.oneShots = [];
  }

  update(dt: number, listener: { x: number; y: number; z: number }, indoors: boolean): void {
    const now = this.graph.now;
    const changed = indoors !== this.indoors;
    this.indoors = indoors;
    for (const bed of this.beds) {
      bed.driftIn -= dt;
      if (bed.driftIn <= 0) {
        bed.drift = DRIFT_LOW + (DRIFT_HIGH - DRIFT_LOW) * this.random();
        bed.driftIn = 7 + 9 * this.random();
        bed.gain.gain.setTargetAtTime(this.bedLevel(bed), now, 3.5);
      } else if (changed) {
        bed.gain.gain.setTargetAtTime(this.bedLevel(bed), now, 0.35);
      }
    }
    if (changed) this.graph.setIndoors(indoors);

    if (this.oneShots.length === 0) return;
    this.nextOneShot -= dt;
    if (this.nextOneShot > 0) return;
    this.nextOneShot = ONESHOT_MIN_GAP + (ONESHOT_MAX_GAP - ONESHOT_MIN_GAP) * this.random();
    this.playOneShot(listener);
  }

  private bedLevel(bed: Bed): number {
    return bed.volume * bed.drift * (this.indoors ? bed.indoor : bed.outdoor);
  }

  private addBed(id: string, volume: number, indoor: number, outdoor: number, destination: AudioNode): void {
    const sound = this.sound(id);
    if (!sound) return;
    const context = this.graph.context;
    const now = this.graph.now;
    const source = new AudioBufferSourceNode(context, { buffer: sound.buffer, loop: true, loopStart: sound.loopStart, loopEnd: sound.loopEnd });
    const gain = new GainNode(context, { gain: 0 });
    source.connect(gain).connect(destination);
    const bed: Bed = { id, source, gain, volume, indoor, outdoor, drift: 1, driftIn: 4 + 8 * this.random() };
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(this.bedLevel(bed), now + FADE_IN);
    // Start each bed at a different point of its loop so two maps never open on the same second.
    source.start(now, sound.loopStart + this.random() * (sound.loopEnd - sound.loopStart));
    this.beds.push(bed);
  }

  private playOneShot(listener: { x: number; y: number; z: number }): void {
    const group = this.oneShots[Math.floor(this.random() * this.oneShots.length)];
    if (!group) return;
    const takes = this.catalog.takes(group);
    const sound = this.sound(takes[this.picker.next(group, takes.length)] ?? '');
    if (!sound) return;
    const angle = this.random() * Math.PI * 2;
    const range = 30 + 70 * this.random();
    // Gulls are overhead; everything else is near the ground.
    const height = group.includes('gull') ? 8 + 25 * this.random() : 1 + 3 * this.random();
    this.position.set(listener.x + Math.cos(angle) * range, listener.y + height, listener.z + Math.sin(angle) * range);
    const request = this.request.reset();
    request.sound = sound;
    request.bus = 'ambience';
    request.position = this.position;
    request.profile = FAR_PROFILE;
    request.volume = 0.5 + 0.35 * this.random();
    request.pitch = jitter(this.random, 0.06);
    request.send = 0.45;
    request.occlude = false;
    request.priority = PRIORITY.low;
    this.pool.play(request);
  }
}
