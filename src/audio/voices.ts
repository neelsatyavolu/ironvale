/**
 * Bookkeeping for the voice pool: which slot a new sound gets, which playing
 * sound it may cut off, and which positional voices get the costly HRTF
 * panner. Holds no audio nodes, so it is testable.
 */

export const PRIORITY = { low: 0, normal: 1, high: 2, critical: 3 } as const;
export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];

export interface VoiceInfo {
  active: boolean;
  /** Start order; lower is older. */
  serial: number;
  priority: Priority;
  /** Voices in one group share a small cap (one shooter's tails, impacts). '' is uncapped. */
  group: string;
  positional: boolean;
  /** Metres from the listener when it started (0 for the player's own sounds). */
  distance: number;
  loop: boolean;
  /** Time before which a just-stopped slot must not be reused, so its fade-out can finish. */
  freeAt: number;
  hrtf: boolean;
}

export interface VoiceRequest {
  readonly priority: Priority;
  readonly group: string;
  /** Most voices of this group that may sound at once; 0 is no cap. */
  readonly groupCap: number;
  readonly positional: boolean;
  readonly distance: number;
  readonly loop: boolean;
}

export interface Acquired {
  /** Slot for the new voice, or -1 when it should not play. */
  readonly slot: number;
  /** Slots to fade out and stop first. */
  readonly stolen: readonly number[];
}

const NONE: Acquired = { slot: -1, stolen: [] };

export class VoiceBook {
  readonly voices: VoiceInfo[];
  private serial = 0;

  /** `slots` should exceed `maxPlaying` so a stolen slot can fade while its replacement starts. */
  constructor(
    slots: number,
    private readonly maxPlaying: number,
  ) {
    this.voices = Array.from({ length: slots }, () => ({
      active: false,
      serial: 0,
      priority: PRIORITY.low,
      group: '',
      positional: false,
      distance: 0,
      loop: false,
      freeAt: 0,
      hrtf: false,
    }));
  }

  get playing(): number {
    let count = 0;
    for (const voice of this.voices) if (voice.active) count++;
    return count;
  }

  acquire(request: VoiceRequest, now: number): Acquired {
    const stolen: number[] = [];

    if (request.groupCap > 0 && request.group !== '') {
      let inGroup = 0;
      for (const voice of this.voices) if (voice.active && voice.group === request.group) inGroup++;
      while (inGroup >= request.groupCap) {
        const oldest = this.oldest((voice) => voice.group === request.group);
        if (oldest < 0) break;
        this.release(oldest, now);
        stolen.push(oldest);
        inGroup--;
      }
    }

    if (this.playing >= this.maxPlaying) {
      const victim = this.victim(request.priority);
      if (victim < 0) {
        // Nothing may be cut for this sound; anything already stolen for its group stays stopped.
        return stolen.length ? { slot: -1, stolen } : NONE;
      }
      this.release(victim, now);
      stolen.push(victim);
    }

    const slot = this.voices.findIndex((voice) => !voice.active && voice.freeAt <= now);
    if (slot < 0) return stolen.length ? { slot: -1, stolen } : NONE;
    const voice = this.voices[slot]!;
    voice.active = true;
    voice.serial = ++this.serial;
    voice.priority = request.priority;
    voice.group = request.group;
    voice.positional = request.positional;
    voice.distance = request.distance;
    voice.loop = request.loop;
    voice.hrtf = false;
    return { slot, stolen };
  }

  /** Mark a slot free. `fade` seconds keep it out of reuse while its gain ramps down. */
  release(slot: number, now: number, fade = 0.04): void {
    const voice = this.voices[slot];
    if (!voice) return;
    voice.active = false;
    voice.freeAt = now + fade;
  }

  /**
   * The voice a new sound of `priority` may replace: the lowest priority
   * playing, and among those the oldest. Loops and anything more important
   * than the newcomer are never taken.
   */
  victim(priority: Priority): number {
    let lowest: Priority = PRIORITY.critical;
    for (const voice of this.voices) if (voice.active && !voice.loop && voice.priority < lowest) lowest = voice.priority;
    if (lowest > priority) return -1;
    return this.oldest((voice) => !voice.loop && voice.priority === lowest);
  }

  private oldest(match: (voice: VoiceInfo) => boolean): number {
    let found = -1;
    for (let i = 0; i < this.voices.length; i++) {
      const voice = this.voices[i]!;
      if (!voice.active || !match(voice)) continue;
      if (found < 0 || voice.serial < this.voices[found]!.serial) found = i;
    }
    return found;
  }

  /**
   * Decide which positional voices use HRTF: the `max` best by nearness and
   * recency. Sets `hrtf` on every voice and returns the slots whose state changed.
   */
  assignHrtf(max: number, changed: number[] = []): number[] {
    changed.length = 0;
    const ranked: number[] = [];
    for (let i = 0; i < this.voices.length; i++) {
      const voice = this.voices[i]!;
      if (voice.active && voice.positional) ranked.push(i);
    }
    ranked.sort((a, b) => this.hrtfScore(a) - this.hrtfScore(b));
    for (let i = 0; i < this.voices.length; i++) {
      const voice = this.voices[i]!;
      const rank = ranked.indexOf(i);
      const want = rank >= 0 && rank < max;
      if (voice.hrtf !== want) {
        voice.hrtf = want;
        if (voice.active) changed.push(i);
      }
    }
    return changed;
  }

  /** Lower is more deserving: metres away plus a metre for every voice started since. */
  private hrtfScore(slot: number): number {
    const voice = this.voices[slot]!;
    return voice.distance + (this.serial - voice.serial);
  }
}
