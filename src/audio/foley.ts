/**
 * Everything bodies do: weapon handling, footsteps, jumps and landings,
 * casings, cloth, grunts and the low-health heartbeat.
 */
import { Vector3 } from 'three/webgpu';
import type { GameEvents } from '../game/contracts';
import type { Surface } from '../world/types';
import { landingVolume, stepLevel } from './curves';
import type { Mixer } from './mixer';
import { jitter } from './variation';
import { PRIORITY } from './voices';

/** Below this health the heartbeat starts and the mix begins to close in. */
const LOW_HEALTH = 40;
const HURT_GAP = 0.22;
const CALLOUT_GAP = 0.6;
const STEP_PAN = 0.16;
const UP = 0.4;

export class Foley {
  private readonly point = new Vector3();
  private leftFoot = false;
  private lastHurt = -1;
  private lastCallout = -1;
  /** 0 when healthy, 1 at the edge of death. */
  private danger = 0;
  private nextBeat = 0;

  constructor(private readonly mixer: Mixer) {}

  /** Call once a frame while the match is running. */
  update(dt: number): void {
    if (this.danger <= 0) return;
    this.nextBeat -= dt;
    if (this.nextBeat > 0) return;
    // 65 beats a minute when hurt, climbing to 105.
    this.nextBeat = 0.92 - 0.35 * this.danger;
    const beat = this.mixer.begin('snd-heartbeat');
    if (!beat) return;
    beat.volume = 0.45 + 0.5 * this.danger;
    beat.priority = PRIORITY.high;
    beat.group = 'heart';
    beat.groupCap = 2;
    this.mixer.pool.play(beat);
  }

  reset(): void {
    this.danger = 0;
    this.mixer.graph.setNarrow(0);
  }

  matchState(snapshot: GameEvents['matchState']): void {
    const alive = snapshot.phase === 'playing' && snapshot.health > 0;
    const danger = alive && snapshot.health < LOW_HEALTH ? 1 - snapshot.health / LOW_HEALTH : 0;
    if (danger === this.danger) return;
    if (this.danger <= 0) this.nextBeat = 0;
    this.danger = danger;
    this.mixer.graph.setNarrow(danger * 0.6);
  }

  weaponAction(event: GameEvents['weaponAction']): void {
    const { mixer } = this;
    const request = mixer.begin(mixer.catalog.actionGroup(event.weapon, event.stage));
    if (!request) return;
    if (event.local || mixer.isLocal(event.shooterId)) {
      request.volume = 0.8;
      request.send = 0.08;
    } else {
      request.position = event.position;
      request.soundClass = 'foley';
    }
    request.pitch = jitter(mixer.random, 0.025);
    request.group = `action:${event.shooterId}`;
    request.groupCap = 3;
    mixer.pool.play(request);
  }

  weaponSwitch(event: GameEvents['weaponSwitch']): void {
    const { mixer } = this;
    const request = mixer.begin('snd-equip');
    if (!request) return;
    if (event.local || mixer.isLocal(event.shooterId)) {
      request.volume = 0.55;
    } else {
      const owner = mixer.ctx.combat.get(event.shooterId);
      if (!owner) return;
      request.position = this.point.copy(owner.position).setY(owner.position.y + 1.2);
      request.soundClass = 'foley';
    }
    request.pitch = jitter(mixer.random, 0.05);
    mixer.pool.play(request);
  }

  aimChanged(event: GameEvents['aimChanged']): void {
    const request = this.mixer.begin('snd-cloth');
    if (!request) return;
    request.volume = event.aiming ? 0.4 : 0.3;
    request.pitch = jitter(this.mixer.random, 0.08) * (event.aiming ? 1.04 : 0.96);
    request.priority = PRIORITY.low;
    request.group = 'cloth';
    request.groupCap = 2;
    this.mixer.pool.play(request);
  }

  casingLanded(event: GameEvents['casingLanded']): void {
    const { mixer } = this;
    const request = mixer.begin(mixer.catalog.casingGroup(event.kind, event.surface));
    if (!request) return;
    request.position = this.point.copy(event.position).setY(event.position.y + 0.1);
    request.soundClass = 'casing';
    request.volume = 0.7 + 0.3 * mixer.random();
    request.pitch = jitter(mixer.random, 0.08);
    request.priority = PRIORITY.low;
    request.group = 'casing';
    request.groupCap = 4;
    request.occlude = false;
    mixer.pool.play(request);
  }

  footstep(event: GameEvents['footstep']): void {
    const { mixer } = this;
    const local = event.local || mixer.isLocal(event.ownerId);
    const crouching = local ? mixer.ctx.player.crouching : (mixer.ctx.combat.get(event.ownerId)?.crouching ?? false);
    const level = stepLevel(event.running, crouching);
    this.step(event.ownerId, event.position, event.surface, event.running, local, level.volume, level.pitch);
    if (!local) return;
    // Kit shifts on every stride, more when running.
    const gear = mixer.begin('snd-gear');
    if (!gear) return;
    gear.volume = event.running ? 0.6 : 0.34;
    gear.pan = this.leftFoot ? -0.1 : 0.1;
    gear.pitch = jitter(mixer.random, 0.08);
    gear.priority = PRIORITY.low;
    gear.group = 'gear';
    gear.groupCap = 2;
    gear.delay = 0.03;
    mixer.pool.play(gear);
  }

  jumped(event: GameEvents['jumped']): void {
    const { mixer } = this;
    const local = event.local || mixer.isLocal(event.ownerId);
    const request = mixer.begin('snd-jump');
    if (!request) return;
    if (local) {
      request.volume = 0.6;
    } else {
      request.position = this.point.copy(event.position).setY(event.position.y + UP);
      request.soundClass = 'footstep';
    }
    request.pitch = jitter(mixer.random, 0.06);
    mixer.pool.play(request);
  }

  landed(event: GameEvents['landed']): void {
    const { mixer } = this;
    const local = event.local || mixer.isLocal(event.ownerId);
    const volume = landingVolume(event.speed);
    const request = mixer.begin(mixer.catalog.landGroup(event.surface));
    if (request) {
      if (local) {
        request.volume = volume;
      } else {
        request.position = this.point.copy(event.position).setY(event.position.y + UP);
        request.soundClass = 'footstep';
        request.volume = volume;
      }
      request.pitch = jitter(mixer.random, 0.05);
      request.priority = PRIORITY.high;
      mixer.pool.play(request);
    }
    // The surface itself under the thump: both feet, so no pan.
    this.step(event.ownerId, event.position, event.surface, true, local, 0.5 + 0.5 * volume, 0.94, false);
  }

  playerHurt(event: GameEvents['playerHurt']): void {
    const { mixer } = this;
    if (mixer.clock - this.lastHurt < HURT_GAP) return;
    this.lastHurt = mixer.clock;
    const pan = Math.max(-0.6, Math.min(0.6, event.direction.dot(mixer.right) * 0.6));
    const thud = mixer.begin('snd-impact-flesh');
    if (thud) {
      thud.volume = 0.9;
      thud.pan = pan;
      thud.priority = PRIORITY.critical;
      mixer.pool.play(thud);
    }
    const grunt = mixer.begin('snd-hurt');
    if (grunt) {
      grunt.volume = Math.min(1, 0.55 + event.amount / 80);
      grunt.pitch = jitter(mixer.random, 0.04);
      grunt.priority = PRIORITY.critical;
      grunt.group = 'voice:local';
      grunt.groupCap = 1;
      grunt.delay = 0.05;
      mixer.pool.play(grunt);
    }
  }

  died(event: GameEvents['died']): void {
    const { mixer } = this;
    const fall = mixer.begin('snd-bodyfall');
    if (!fall) return;
    if (mixer.isLocal(event.victimId)) {
      fall.volume = 0.9;
      fall.priority = PRIORITY.critical;
      mixer.pool.play(fall);
      this.reset();
      return;
    }
    const victim = mixer.ctx.combat.get(event.victimId);
    if (!victim) return;
    fall.position = this.point.copy(victim.position).setY(victim.position.y + UP);
    fall.soundClass = 'voice';
    fall.delay = 0.35;
    mixer.pool.play(fall);
    this.voice(event.victimId, this.point, 0.85, 0.94);
  }

  /** Bots make a short breath or grunt at most; there is no speech. */
  botCallout(event: GameEvents['botCallout']): void {
    const { mixer } = this;
    if (event.kind === 'death' || event.kind === 'reloading') return;
    if (mixer.clock - this.lastCallout < CALLOUT_GAP) return;
    this.lastCallout = mixer.clock;
    this.point.copy(event.position).setY(event.position.y + 1.5);
    if (event.kind === 'hurt') {
      this.voice(event.botId, this.point, 0.7, 1);
      return;
    }
    const breath = mixer.begin('snd-breath');
    if (!breath) return;
    breath.position = this.point;
    breath.soundClass = 'voice';
    breath.volume = 0.5;
    breath.pitch = this.voicePitch(event.botId);
    breath.priority = PRIORITY.low;
    mixer.pool.play(breath);
  }

  private voice(ownerId: number, position: Vector3, volume: number, pitch: number): void {
    const grunt = this.mixer.begin('snd-hurt');
    if (!grunt) return;
    grunt.position = position;
    grunt.soundClass = 'voice';
    grunt.volume = volume;
    grunt.pitch = pitch * this.voicePitch(ownerId) * jitter(this.mixer.random, 0.03);
    grunt.group = `voice:${ownerId}`;
    grunt.groupCap = 1;
    this.mixer.pool.play(grunt);
  }

  /** Each soldier keeps his own voice: a fixed pitch offset from his id. */
  private voicePitch(ownerId: number): number {
    return 0.9 + (ownerId % 6) * 0.035;
  }

  private step(ownerId: number, position: Vector3, surface: Surface, running: boolean, local: boolean, volume: number, pitch: number, alternate = true): void {
    const { mixer } = this;
    const request = mixer.begin(mixer.catalog.stepGroup(surface, running));
    if (!request) return;
    if (local) {
      if (alternate) this.leftFoot = !this.leftFoot;
      request.pan = alternate ? (this.leftFoot ? -STEP_PAN : STEP_PAN) : 0;
      request.volume = volume * 0.85;
    } else {
      request.position = this.point.copy(position).setY(position.y + UP);
      request.soundClass = 'footstep';
      request.volume = volume;
    }
    request.pitch = pitch * jitter(mixer.random, 0.05);
    request.send = 0.06;
    request.group = `step:${ownerId}`;
    request.groupCap = 3;
    mixer.pool.play(request);
  }
}
