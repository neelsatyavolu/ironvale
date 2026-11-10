/**
 * Gunshots, fly-bys, impacts and hit confirmation. A shot is several layers:
 * close crack and body, a recorded outdoor tail, a sub thump and the action
 * for the shooter, and a distant take that replaces the crack with range.
 */
import { Vector3 } from 'three/webgpu';
import type { GameEvents, WeaponDef } from '../game/contracts';
import { SUB_BUFFER } from './graph';
import { chooseShotLayers } from './layers';
import type { Mixer } from './mixer';
import { jitter } from './variation';
import { PRIORITY } from './voices';

const PITCH_JITTER = 0.03;
const LEVEL_JITTER = 0.07;
/** Overlapping voices allowed per shooter and layer; the oldest is faded out beyond this. */
const CRACK_CAP = 4;
const TAIL_CAP = 4;
const IMPACTS_PER_FRAME = 4;
const NEAR_MISS_GAP = 0.07;
const HIT_TICK_GAP = 0.05;
const RICOCHET_CHANCE = 0.16;
const SUPERSONIC = 360;
const DISTANT_TRIM = 1.8;

export class Gunfire {
  private readonly point = new Vector3();
  private impactsThisFrame = 0;
  private lastNearMiss = -1;
  private lastHitTick = -1;

  constructor(private readonly mixer: Mixer) {}

  /** Call once a frame. */
  update(): void {
    this.impactsThisFrame = 0;
  }

  shot(event: GameEvents['shotFired']): void {
    const { mixer } = this;
    const { weapon, muzzle } = event;
    const local = event.local || mixer.isLocal(event.shooterId);
    const distance = local ? 0 : mixer.pool.distanceTo(muzzle);
    const layers = chooseShotLayers({ local, distance, environment: mixer.environment });
    const loud = 0.7 + 0.3 * weapon.loudness;
    const level = loud * jitter(mixer.random, LEVEL_JITTER);
    const pitch = jitter(mixer.random, PITCH_JITTER);
    const position = local ? null : muzzle;
    // One ray for the whole shot instead of one per layer.
    const occlusion = local ? null : mixer.pool.occlusionAt(muzzle);

    if (layers.close > 0.02) {
      const request = mixer.begin(mixer.catalog.weaponGroup(weapon, 'shot'));
      if (request) {
        request.position = position;
        request.occlusion = occlusion;
        request.soundClass = 'gunshot';
        request.volume = level * layers.close;
        request.pitch = pitch;
        request.send = layers.reverbSend;
        request.priority = local ? PRIORITY.critical : PRIORITY.high;
        request.group = `shot:${event.shooterId}`;
        request.groupCap = CRACK_CAP;
        mixer.pool.play(request);
      }
    }
    if (layers.distant > 0.02) {
      const request = mixer.begin(mixer.catalog.weaponGroup(weapon, 'dist'));
      if (request) {
        request.position = position;
        request.occlusion = occlusion;
        request.soundClass = 'gunshot';
        // The mid-distance takes are quieter recordings than the close ones; bring them level.
        request.volume = level * layers.distant * DISTANT_TRIM;
        request.pitch = pitch;
        request.send = layers.reverbSend * 0.5;
        request.priority = PRIORITY.normal;
        request.group = `dist:${event.shooterId}`;
        request.groupCap = TAIL_CAP;
        mixer.pool.play(request);
      }
    }
    if (layers.tail > 0.02) {
      const request = mixer.begin(mixer.catalog.weaponGroup(weapon, 'tail'));
      if (request) {
        request.position = position;
        request.occlusion = occlusion;
        request.soundClass = 'gunshot';
        request.volume = loud * layers.tail * (local ? 0.85 : 0.75);
        request.pitch = pitch;
        request.cutoff = layers.tailCutoff;
        request.send = layers.reverbSend * 0.4;
        request.priority = local ? PRIORITY.high : PRIORITY.normal;
        request.group = `tail:${event.shooterId}`;
        request.groupCap = TAIL_CAP;
        request.delay = 0.015;
        mixer.pool.play(request);
      }
    }
    if (layers.mech > 0.02) {
      const request = mixer.begin(mixer.catalog.weaponGroup(weapon, 'mech'));
      if (request) {
        request.position = position;
        request.occlusion = occlusion;
        request.soundClass = 'foley';
        request.volume = layers.mech;
        request.pitch = jitter(mixer.random, 0.04);
        request.group = `mech:${event.shooterId}`;
        request.groupCap = 2;
        request.delay = 0.028;
        mixer.pool.play(request);
      }
    }
    if (layers.sub > 0) this.sub(weapon, layers.sub);

    // The shooter's own gun pushes the world down for a moment; a close neighbour's does a little.
    if (local) mixer.graph.duckAmbience(0.32, 0.14, 0.4);
    else if (distance < 30) mixer.graph.duckAmbience(0.7, 0.08, 0.3);
  }

  private sub(weapon: WeaponDef, amount: number): void {
    const sound = this.mixer.sound(SUB_BUFFER);
    if (!sound) return;
    const request = this.mixer.request.reset();
    request.sound = sound;
    request.volume = amount * (0.55 + 0.45 * weapon.loudness);
    // Bigger rounds thump lower.
    request.pitch = 1.15 - 0.3 * weapon.loudness;
    request.priority = PRIORITY.high;
    request.group = 'sub';
    request.groupCap = 2;
    this.mixer.pool.play(request);
  }

  /** A round passed close: the crack first, then the whiz, on the side it went by. */
  nearMiss(event: GameEvents['nearMiss']): void {
    const { mixer } = this;
    if (mixer.clock - this.lastNearMiss < NEAR_MISS_GAP) return;
    this.lastNearMiss = mixer.clock;
    const raw = mixer.panFor(event.point, 1.2);
    // A pass dead ahead still gets a side, so it never sounds like it came from inside the head.
    const pan = Math.sign(raw || mixer.random() - 0.5) * Math.max(0.35, Math.abs(raw));
    const supersonic = event.weapon.muzzleVelocity > SUPERSONIC;

    if (supersonic) {
      const crack = mixer.begin('snd-bullet-crack');
      if (crack) {
        crack.volume = 0.85;
        crack.pan = pan;
        crack.pitch = jitter(mixer.random, 0.08);
        crack.send = 0.15;
        crack.priority = PRIORITY.high;
        crack.group = 'crack';
        crack.groupCap = 3;
        mixer.pool.play(crack);
      }
    }
    const whiz = mixer.begin('snd-bullet-whiz');
    if (whiz) {
      whiz.volume = 0.7;
      whiz.pan = pan * 0.9;
      whiz.pitch = jitter(mixer.random, 0.1);
      whiz.priority = PRIORITY.high;
      whiz.group = 'whiz';
      whiz.groupCap = 3;
      whiz.delay = supersonic ? 0.035 : 0;
      mixer.pool.play(whiz);
    }
  }

  impact(event: GameEvents['bulletImpact']): void {
    const { mixer } = this;
    if (this.impactsThisFrame >= IMPACTS_PER_FRAME) return;
    this.impactsThisFrame++;
    const { hit } = event;
    // Lift the source off the surface so the line-of-sight test does not start inside the wall.
    const position = this.point.copy(hit.point).addScaledVector(hit.normal, 0.15);
    const occlusion = mixer.pool.occlusionAt(position);

    const request = mixer.begin(mixer.catalog.impactGroup(hit.surface));
    if (request) {
      request.position = position;
      request.occlusion = occlusion;
      request.soundClass = 'impact';
      request.volume = 0.8 + 0.2 * mixer.random();
      request.pitch = jitter(mixer.random, 0.07);
      request.send = 0.2;
      request.group = 'impact';
      request.groupCap = 6;
      mixer.pool.play(request);
    }
    if (mixer.catalog.ricochets(hit.surface) && mixer.random() < RICOCHET_CHANCE) {
      const ricochet = mixer.begin('snd-ricochet');
      if (ricochet) {
        ricochet.position = position;
        ricochet.occlusion = occlusion;
        ricochet.soundClass = 'impact';
        ricochet.volume = 0.55;
        ricochet.pitch = jitter(mixer.random, 0.12);
        ricochet.send = 0.3;
        ricochet.priority = PRIORITY.low;
        ricochet.group = 'ricochet';
        ricochet.groupCap = 2;
        ricochet.delay = 0.02;
        mixer.pool.play(ricochet);
      }
    }
  }

  combatantHit(event: GameEvents['combatantHit']): void {
    const { mixer } = this;
    // The player's own wounds are voiced by `playerHurt`.
    if (mixer.isLocal(event.targetId)) return;
    const request = mixer.begin('snd-impact-flesh');
    if (request) {
      request.position = event.hit.point;
      request.soundClass = 'impact';
      request.volume = 0.8;
      request.pitch = jitter(mixer.random, 0.08);
      request.group = 'flesh';
      request.groupCap = 3;
      mixer.pool.play(request);
    }
    if (!mixer.isLocal(event.attackerId) || !mixer.ctx.settings.value.gameplay.showHitMarkers) return;
    if (!event.fatal && mixer.clock - this.lastHitTick < HIT_TICK_GAP) return;
    this.lastHitTick = mixer.clock;
    const tick = mixer.begin(event.fatal ? 'snd-ui-kill' : 'snd-ui-hit');
    if (tick) {
      tick.bus = 'interface';
      tick.volume = event.fatal ? 0.9 : 0.7;
      tick.priority = PRIORITY.high;
      tick.group = 'tick';
      tick.groupCap = 2;
      mixer.pool.play(tick);
    }
  }

  dryFire(event: GameEvents['dryFire']): void {
    const { mixer } = this;
    const request = mixer.begin(mixer.catalog.weaponGroup(event.weapon, 'dry'));
    if (!request) return;
    if (mixer.isLocal(event.shooterId)) {
      request.volume = 0.7;
    } else {
      request.position = event.position;
      request.soundClass = 'foley';
    }
    request.pitch = jitter(mixer.random, 0.03);
    mixer.pool.play(request);
  }
}
