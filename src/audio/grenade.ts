/** The hand grenade: pin and throw, each bounce, and the blast with a close and a distant take. */
import type { GameEvents } from '../game/contracts';
import type { DistanceProfile } from './curves';
import type { Mixer } from './mixer';
import { jitter } from './variation';
import { PRIORITY } from './voices';

/** The close take carries to here, then gives way to the distant one. */
const CLOSE_UNTIL = 30;
const DISTANT_FROM = 110;
/** Louder and further-carrying than a gunshot. */
const BLAST_PROFILE: DistanceProfile = { ref: 12, max: 900, rolloff: 0.55, airHalf: 70, minCutoff: 500, delayed: true };
/** The close take is pushed past the gunshots: it should be the loudest thing in a match. */
const CLOSE_GAIN = 1.25;
/** A bounce at this speed into the ground (m/s) is at full level. */
const FULL_BOUNCE_SPEED = 7;

function smoothstep(from: number, to: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

export class GrenadeAudio {
  constructor(private readonly mixer: Mixer) {}

  thrown(event: GameEvents['grenadeThrown']): void {
    const { mixer } = this;
    const local = event.local || mixer.isLocal(event.ownerId);
    const pin = mixer.begin('snd-grenade-pin');
    if (pin) {
      if (local) pin.volume = 0.45;
      else {
        pin.position = event.position;
        pin.soundClass = 'foley';
      }
      pin.pitch = jitter(mixer.random, 0.03);
      mixer.pool.play(pin);
    }
    const swing = mixer.begin('snd-grenade-throw');
    if (!swing) return;
    if (local) swing.volume = 0.6;
    else {
      swing.position = event.position;
      swing.soundClass = 'foley';
    }
    swing.pitch = jitter(mixer.random, 0.06);
    swing.delay = 0.05;
    mixer.pool.play(swing);
  }

  bounced(event: GameEvents['grenadeBounced']): void {
    const { mixer } = this;
    const request = mixer.begin('snd-grenade-bounce');
    if (!request) return;
    request.position = event.position;
    request.soundClass = 'impact';
    request.volume = 0.25 + 0.75 * Math.min(1, event.speed / FULL_BOUNCE_SPEED);
    // Softer ground gives a duller knock.
    request.cutoff = mixer.catalog.casingGroup('rifle', event.surface).endsWith('soft') ? 1800 : request.cutoff;
    request.pitch = jitter(mixer.random, 0.07);
    request.group = 'grenade-bounce';
    request.groupCap = 3;
    mixer.pool.play(request);
  }

  exploded(event: GameEvents['grenadeExploded']): void {
    const { mixer } = this;
    const distance = mixer.pool.distanceTo(event.position);
    // One ray for both takes.
    const occlusion = mixer.pool.occlusionAt(event.position);
    const far = smoothstep(CLOSE_UNTIL, DISTANT_FROM, distance);
    const pitch = jitter(mixer.random, 0.04);

    const closeLevel = Math.cos((far * Math.PI) / 2);
    if (closeLevel > 0.02) {
      const close = mixer.begin('snd-grenade-explode');
      if (close) {
        close.position = event.position;
        close.occlusion = occlusion;
        close.profile = BLAST_PROFILE;
        close.volume = closeLevel * CLOSE_GAIN;
        close.pitch = pitch;
        close.send = 0.3;
        close.priority = PRIORITY.critical;
        close.group = 'grenade-blast';
        close.groupCap = 2;
        mixer.pool.play(close);
      }
    }
    const distantLevel = Math.sin((far * Math.PI) / 2);
    if (distantLevel > 0.02) {
      const distant = mixer.begin('snd-grenade-explode-dist');
      if (distant) {
        distant.position = event.position;
        distant.occlusion = occlusion;
        distant.profile = BLAST_PROFILE;
        distant.volume = distantLevel;
        distant.pitch = pitch;
        distant.send = 0.2;
        distant.priority = PRIORITY.high;
        distant.group = 'grenade-blast-far';
        distant.groupCap = 2;
        mixer.pool.play(distant);
      }
    }
    // A blast nearby pushes the world down for a moment.
    if (distance < 60) mixer.graph.duckAmbience(0.3, 0.25, 0.9);
  }
}
