/**
 * What the event handlers share: the pool, the graph, decoded buffers, the
 * variation picker and the listener's frame. Exists only once audio is unlocked.
 */
import { Vector3 } from 'three/webgpu';
import type { GameContext } from '../game/contracts';
import type { ReverbPreset } from '../world/types';
import type { Catalog } from './catalog';
import type { AudioGraph } from './graph';
import { PlayRequest, type DecodedSound, type VoicePool } from './pool';
import { VariationPicker } from './variation';

export class Mixer {
  readonly picker: VariationPicker;
  readonly request = new PlayRequest();
  /** Unit vector to the listener's right, refreshed every frame. */
  readonly right = new Vector3(1, 0, 0);
  /** Reverb preset in force this frame. */
  environment: ReverbPreset = 'open-field';
  /** Seconds since audio started; for rate limits. */
  clock = 0;

  constructor(
    readonly ctx: GameContext,
    readonly graph: AudioGraph,
    readonly pool: VoicePool,
    readonly catalog: Catalog,
    private readonly buffers: ReadonlyMap<string, DecodedSound>,
    readonly random: () => number,
  ) {
    this.picker = new VariationPicker(random);
  }

  sound(id: string): DecodedSound | null {
    return this.buffers.get(id) ?? null;
  }

  /**
   * Start a play request for the next take of `group`. Returns null when the
   * group has no decoded sound, so a missing id is skipped rather than thrown.
   */
  begin(group: string | null): PlayRequest | null {
    if (!group) return null;
    const takes = this.catalog.takes(group);
    if (takes.length === 0) return null;
    const sound = this.buffers.get(takes[this.picker.next(group, takes.length)]!);
    if (!sound) return null;
    const request = this.request.reset();
    request.sound = sound;
    return request;
  }

  /** -1 (hard left) to 1 (hard right) for a world position, by how far to the side it lies. */
  panFor(position: Vector3, fullAt: number): number {
    const listener = this.pool.listener;
    const side =
      (position.x - listener.x) * this.right.x + (position.y - listener.y) * this.right.y + (position.z - listener.z) * this.right.z;
    return Math.max(-1, Math.min(1, side / fullAt));
  }

  isLocal(combatantId: number): boolean {
    return combatantId === this.ctx.player.id;
  }
}
