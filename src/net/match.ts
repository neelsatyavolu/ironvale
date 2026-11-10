import { Vector3 } from 'three/webgpu';
import { createSoldier } from '../characters/index';
import type { Combatant, DamageInfo, GameContext, GameEvents, Team, WeaponDef } from '../game/contracts';
import { WEAPON_DEFS } from '../weapons/defs';
import { closestPointOnSegment } from '../weapons/math';
import { WEAPON_IDS, type WeaponId } from '../weapons/models/api';
import type { NetGameHooks, NetRole } from './api';
import type { ClockSync } from './clock';
import { TokenBucket, WeaponGate, capDamage } from './limits';
import {
  MAX_BOTS_PER_SNAPSHOT,
  MAX_PELLETS,
  MAX_WIRE_ID,
  WIRE_BOT_BASE,
  WIRE_GUEST,
  WIRE_HOST,
  encodeBotSnapshot,
  encodePlayerState,
  encodeShot,
  type BinaryMessage,
  type BotState,
  type NetEvent,
  type NetMatchConfig,
  type PlayerState,
  type ShotMessage,
  type Vec3,
} from './protocol';
import { BotProxies, MAX_PROXIES } from './proxies';
import { RemoteSoldier } from './remote-soldier';

const STATE_INTERVAL = 1 / 30;
const BOT_INTERVAL = 1 / 12;
/** The other player is shown this far in the past, so there are always two snapshots to blend. */
const PLAYER_DELAY_MS = 100;
const MAX_EXTRAPOLATION_MS = 250;
/** State older than this on arrival is not worth showing. */
const STALE_MS = 2000;
const NEAR_MISS_RADIUS = 1.2;
const NOBODY = -1;

/** The parts of a host's bot that are sent to the guest. `src/ai/bot.ts` has them all. */
interface BotView extends Combatant {
  readonly yaw: number;
  readonly pitch: number;
  readonly speed: number;
  readonly watch: string;
  readonly weaponDef: WeaponDef;
  readonly weapon: { readonly reloading: boolean };
}

export interface MatchLink {
  readonly clock: ClockSync;
  sendState(data: ArrayBuffer): void;
  sendEvent(event: NetEvent): void;
  sendShot(data: ArrayBuffer): void;
}

export interface MatchSyncOptions {
  readonly ctx: GameContext;
  readonly hooks: NetGameHooks;
  readonly link: MatchLink;
  readonly role: NetRole;
  readonly config: NetMatchConfig;
  readonly peerName: string;
}

interface PendingShot {
  readonly shooterId: number;
  readonly message: { actor: number; weapon: WeaponId; muzzle: Vec3; direction: Vec3; ends: Vec3[] };
}

interface PendingDeath {
  readonly victimId: number;
  readonly killerId: number;
  readonly weapon: WeaponId;
  readonly headshot: boolean;
}

const a = new Vector3();
const b = new Vector3();
const c = new Vector3();
const head = new Vector3();
const nearest = new Vector3();

function isWeaponId(id: string): id is WeaponId {
  return (WEAPON_IDS as readonly string[]).includes(id);
}

function triple(v: Vector3): Vec3 {
  return [v.x, v.y, v.z];
}

/**
 * Keeps one match in step with the other machine: sends this player's state,
 * shots and hits, shows the other player (and, for a co-op guest, the host's
 * bots) and replays what they do as ordinary game events.
 */
export class MatchSync {
  readonly remote: RemoteSoldier;
  /** Deaths of the other player this match. */
  partnerDeaths = 0;
  /** Bot kills by the other player this match. */
  partnerKills = 0;
  /** Guest: the host's latest word on waves and enemies. */
  hostMatch: { wave: number; enemies: number } | null = null;
  /** Local clock time the last state arrived from the other player. */
  lastStateAt = Number.POSITIVE_INFINITY;

  private readonly ctx: GameContext;
  private readonly hooks: NetGameHooks;
  private readonly link: MatchLink;
  private readonly role: NetRole;
  private readonly coop: boolean;
  private readonly myWire: number;
  private readonly peerWire: number;
  /** Guest: stand-ins for the host's bots. Empty on a host and in a duel. */
  readonly proxies: BotProxies;
  private readonly gates = new Map<number, WeaponGate>();
  private readonly actionGate = new TokenBucket(30, 30);
  private readonly unsubscribe: (() => void)[];
  private readonly fatalDirections = new Map<number, Vec3>();
  private readonly lastHurt = new Vector3(0, 0, -1);
  private pendingShot: PendingShot | null = null;
  private pendingDeaths: PendingDeath[] = [];
  private remoteGone = false;
  private life = 0;
  private seq = 0;
  private botSeq = 0;
  private stateTimer = 0;
  private botTimer = 0;
  private lastPeerDeathLife = -1;

  constructor(options: MatchSyncOptions) {
    const { ctx } = options;
    this.ctx = ctx;
    this.hooks = options.hooks;
    this.link = options.link;
    this.role = options.role;
    this.coop = options.config.mode === 'coop';
    this.myWire = options.role === 'host' ? WIRE_HOST : WIRE_GUEST;
    this.peerWire = options.role === 'host' ? WIRE_GUEST : WIRE_HOST;
    // In a duel the opponent is the other side on both machines. The uniform still tells
    // them apart the same way for both: the host wears alpha, the guest bravo.
    const team: Team = this.coop ? 'alpha' : 'bravo';
    const uniform: Team = this.coop ? 'alpha' : options.role === 'host' ? 'bravo' : 'alpha';
    this.remote = new RemoteSoldier(ctx, {
      id: ctx.combat.allocateId(),
      wireId: this.peerWire,
      team,
      name: options.peerName,
      visual: createSoldier(ctx.assets, uniform),
      weapon: 'm4a1',
      delayMs: PLAYER_DELAY_MS,
      maxExtrapolationMs: MAX_EXTRAPOLATION_MS,
      deriveVelocity: false,
      onDamage: (target, info) => this.forwardDamage(target, info),
    });
    ctx.combat.add(this.remote);
    ctx.engine.scene.add(this.remote.visual.root);
    this.proxies = new BotProxies(ctx, (target, info) => this.forwardDamage(target, info));

    const events = ctx.events;
    this.unsubscribe = [
      events.on('shotFired', (event) => this.onShotFired(event)),
      events.on('bulletTrace', (event) => this.onTrace(event)),
      events.on('weaponAction', (event) => this.onAction(event)),
      events.on('weaponSwitch', (event) => this.onSwitch(event)),
      events.on('spawned', (event) => this.onSpawned(event)),
      events.on('died', (event) => this.onDied(event)),
      events.on('combatantHit', (event) => {
        if (event.fatal) this.fatalDirections.set(event.targetId, triple(event.direction));
      }),
    ];
  }

  /** Living bot stand-ins on a guest. */
  get proxiesAlive(): number {
    return this.proxies.alive;
  }

  // ---------------------------------------------------------------- per frame

  /** `running` is false once the match is over: what is already decided still goes out, nothing new is sent. */
  update(dt: number, now: number, running: boolean): void {
    this.flush();
    if (!running) return;
    if (!this.remoteGone) this.remote.update(dt, now);
    this.proxies.update(dt, now);
    if (this.remoteGone) return;

    this.stateTimer += dt;
    if (this.stateTimer >= STATE_INTERVAL) {
      this.stateTimer = Math.min(this.stateTimer - STATE_INTERVAL, STATE_INTERVAL);
      this.link.sendState(encodePlayerState(this.localState(now)));
    }
    if (this.role === 'host' && this.coop) {
      this.botTimer += dt;
      if (this.botTimer >= BOT_INTERVAL) {
        this.botTimer = Math.min(this.botTimer - BOT_INTERVAL, BOT_INTERVAL);
        this.sendBots(now);
      }
    }
  }

  /** Send the shots and deaths gathered since the last frame. */
  flush(): void {
    this.flushShot();
    this.flushDeaths();
  }

  private localState(now: number): PlayerState {
    const player = this.ctx.player;
    const weapons = this.hooks.weapons;
    const weapon = weapons.current.def.id;
    return {
      seq: this.seq++ & 0xffff,
      time: now,
      x: player.position.x,
      y: player.position.y,
      z: player.position.z,
      vx: player.velocity.x,
      vy: player.velocity.y,
      vz: player.velocity.z,
      yaw: player.yaw,
      pitch: player.pitch,
      crouching: player.crouching,
      sprinting: player.sprinting,
      aiming: weapons.aimBlend > 0.5,
      alive: player.alive,
      onGround: player.onGround,
      reloading: weapons.current.reloading,
      weapon: isWeaponId(weapon) ? weapon : 'm4a1',
      health: player.health,
      life: this.life,
    };
  }

  private sendBots(now: number): void {
    const bots: BotState[] = [];
    for (const combatant of this.ctx.combat.all()) {
      if (combatant.kind !== 'bot') continue;
      const bot = combatant as BotView;
      const weapon = bot.weaponDef.id;
      bots.push({
        id: bot.id + WIRE_BOT_BASE,
        x: bot.position.x,
        y: bot.position.y,
        z: bot.position.z,
        yaw: bot.yaw,
        pitch: bot.pitch,
        speed: bot.speed,
        crouching: bot.crouching,
        aiming: bot.watch === 'enemy',
        reloading: bot.weapon.reloading,
        alive: bot.alive,
        weapon: isWeaponId(weapon) ? weapon : 'm4a1',
      });
    }
    for (let from = 0; from < bots.length || from === 0; from += MAX_BOTS_PER_SNAPSHOT) {
      this.link.sendState(encodeBotSnapshot(this.botSeq++ & 0xffff, now, bots.slice(from, from + MAX_BOTS_PER_SNAPSHOT)));
    }
  }

  // ---------------------------------------------------------------- local events out

  private isLocalShooter(id: number): boolean {
    if (id === this.ctx.player.id) return true;
    return this.role === 'host' && this.coop && this.ctx.combat.get(id)?.kind === 'bot';
  }

  private wireOf(localId: number): number {
    if (localId === this.ctx.player.id) return this.myWire;
    if (localId === this.remote.id) return this.peerWire;
    const proxy = this.proxies.local(localId);
    if (proxy) return proxy.wireId;
    if (this.role === 'host' && this.ctx.combat.get(localId)?.kind === 'bot') return localId + WIRE_BOT_BASE;
    return MAX_WIRE_ID;
  }

  private localOf(wire: number): Combatant | undefined {
    if (wire === this.myWire) return this.ctx.player;
    if (wire === this.peerWire) return this.remoteGone ? undefined : this.remote;
    if (wire < WIRE_BOT_BASE) return undefined;
    if (this.role === 'guest') return this.proxies.get(wire);
    const bot = this.ctx.combat.get(wire - WIRE_BOT_BASE);
    return bot?.kind === 'bot' ? bot : undefined;
  }

  private onShotFired(event: GameEvents['shotFired']): void {
    if (!this.isLocalShooter(event.shooterId) || !isWeaponId(event.weapon.id)) return;
    this.flushShot();
    this.pendingShot = {
      shooterId: event.shooterId,
      message: {
        actor: this.wireOf(event.shooterId),
        weapon: event.weapon.id,
        muzzle: triple(event.muzzle),
        direction: triple(event.direction),
        ends: [],
      },
    };
  }

  private onTrace(event: GameEvents['bulletTrace']): void {
    const pending = this.pendingShot;
    if (!pending || pending.shooterId !== event.shooterId || pending.message.ends.length >= MAX_PELLETS) return;
    pending.message.ends.push(triple(event.to));
  }

  private flushShot(): void {
    const pending = this.pendingShot;
    if (!pending) return;
    this.pendingShot = null;
    if (!this.remoteGone) this.link.sendShot(encodeShot(pending.message as ShotMessage));
  }

  private onAction(event: GameEvents['weaponAction']): void {
    if (this.remoteGone || !this.isLocalShooter(event.shooterId) || !isWeaponId(event.weapon.id)) return;
    this.link.sendEvent({ t: 'action', actor: this.wireOf(event.shooterId), weapon: event.weapon.id, stage: event.stage });
  }

  private onSwitch(event: GameEvents['weaponSwitch']): void {
    if (this.remoteGone || !event.local || !isWeaponId(event.weapon.id)) return;
    this.link.sendEvent({ t: 'switch', weapon: event.weapon.id });
  }

  private onSpawned(event: GameEvents['spawned']): void {
    if (event.combatantId === this.ctx.player.id) {
      this.life = Math.min(255, this.life + 1);
      return;
    }
    if (this.role !== 'host' || !this.coop || this.remoteGone) return;
    const combatant = this.ctx.combat.get(event.combatantId);
    if (!combatant || combatant.kind !== 'bot') return;
    const bot = combatant as BotView;
    const weapon = bot.weaponDef.id;
    this.link.sendEvent({
      t: 'botSpawn',
      id: bot.id + WIRE_BOT_BASE,
      name: bot.name,
      weapon: isWeaponId(weapon) ? weapon : 'm4a1',
      p: triple(bot.position),
      yaw: bot.yaw,
    });
  }

  private onDied(event: GameEvents['died']): void {
    if (!isWeaponId(event.weaponId)) return;
    const victim = this.ctx.combat.get(event.victimId);
    const mine = event.victimId === this.ctx.player.id;
    const hostBot = this.role === 'host' && this.coop && victim?.kind === 'bot';
    if (!mine && !hostBot) return;
    if (hostBot && event.killerId === this.remote.id) this.partnerKills++;
    // The fatal hit's direction is announced just after the death: send at the end of the frame.
    this.pendingDeaths = [...this.pendingDeaths, { victimId: event.victimId, killerId: event.killerId, weapon: event.weaponId, headshot: event.headshot }];
  }

  private flushDeaths(): void {
    if (this.pendingDeaths.length === 0) return;
    const deaths = this.pendingDeaths;
    this.pendingDeaths = [];
    for (const death of deaths) {
      const mine = death.victimId === this.ctx.player.id;
      const direction = mine ? triple(this.lastHurt) : (this.fatalDirections.get(death.victimId) ?? [0, 0, -1]);
      this.fatalDirections.delete(death.victimId);
      if (this.remoteGone) continue;
      this.link.sendEvent({
        t: 'death',
        victim: mine ? this.myWire : death.victimId + WIRE_BOT_BASE,
        killer: this.wireOf(death.killerId),
        weapon: death.weapon,
        headshot: death.headshot,
        life: mine ? this.life : 0,
        d: direction,
      });
    }
    this.fatalDirections.clear();
  }

  /** A hit this machine decided on a body the other machine owns. */
  private forwardDamage(target: RemoteSoldier, info: DamageInfo): void {
    if (this.remoteGone || !isWeaponId(info.weaponId)) return;
    this.link.sendEvent({
      t: 'hit',
      target: target.wireId,
      attacker: this.wireOf(info.attackerId),
      weapon: info.weaponId,
      zone: info.zone,
      amount: Math.round(info.amount * 100) / 100,
      p: triple(info.point),
      d: triple(info.direction),
    });
  }

  // ---------------------------------------------------------------- remote messages in

  handleBinary(message: BinaryMessage, now: number): void {
    if (this.remoteGone) return;
    if (message.type === 'state') this.onRemoteState(message.state, now);
    else if (message.type === 'bots') this.onBotSnapshot(message.time, message.bots, now);
    else if (message.type === 'shot') this.onRemoteShot(message.shot, now);
  }

  handleEvent(event: NetEvent, now: number): void {
    if (this.remoteGone) return;
    switch (event.t) {
      case 'hit':
        this.onRemoteHit(event, now);
        break;
      case 'death':
        this.onRemoteDeath(event);
        break;
      case 'action':
        this.onRemoteAction(event, now);
        break;
      case 'switch': {
        this.remote.weapon = event.weapon;
        if (this.actionGate.take(now)) {
          this.ctx.events.emit('weaponSwitch', { shooterId: this.remote.id, weapon: WEAPON_DEFS[event.weapon], local: false });
        }
        break;
      }
      case 'botSpawn':
        if (this.role === 'guest' && this.coop) this.proxies.spawn(event);
        break;
      case 'match':
        if (this.role === 'guest' && this.coop) this.onHostMatch(event);
        break;
      default:
        break;
    }
  }

  /** Sender time on this machine's clock, or null when the message is too old to use. */
  private arrivalTime(sent: number, now: number): number | null {
    const clock = this.link.clock;
    const local = clock.synced ? Math.min(clock.toLocal(sent), now) : now;
    return now - local > STALE_MS ? null : local;
  }

  private onRemoteState(state: PlayerState, now: number): void {
    this.lastStateAt = now;
    const time = this.arrivalTime(state.time, now);
    if (time === null) return;
    this.remote.push(
      { time, epoch: state.life, x: state.x, y: state.y, z: state.z, vx: state.vx, vy: state.vy, vz: state.vz, yaw: state.yaw, pitch: state.pitch },
      {
        crouching: state.crouching,
        aiming: state.aiming,
        reloading: state.reloading,
        running: state.sprinting,
        onGround: state.onGround,
        alive: state.alive,
        health: state.health,
        weapon: state.weapon,
      },
      state.life,
    );
  }

  private onBotSnapshot(sent: number, bots: readonly BotState[], now: number): void {
    if (this.role !== 'guest' || !this.coop) return;
    const time = this.arrivalTime(sent, now);
    if (time !== null) this.proxies.push(time, bots);
  }

  /** Whoever `wire` names must be someone the other machine is allowed to speak for. */
  private remoteActor(wire: number): RemoteSoldier | undefined {
    if (wire === this.peerWire) return this.remote;
    // Only the host has bots, and only in co-op.
    if (this.role === 'guest' && this.coop && wire >= WIRE_BOT_BASE) return this.proxies.get(wire);
    return undefined;
  }

  private gate(wire: number): WeaponGate {
    const existing = this.gates.get(wire);
    if (existing) return existing;
    if (this.gates.size > MAX_PROXIES * 2) this.gates.clear();
    const created = new WeaponGate();
    this.gates.set(wire, created);
    return created;
  }

  private onRemoteShot(shot: ShotMessage, now: number): void {
    const body = this.remoteActor(shot.actor);
    const def = WEAPON_DEFS[shot.weapon];
    if (!body || !this.gate(shot.actor).allowShot(def, now)) return;
    const events = this.ctx.events;
    body.fired();
    const muzzle = body.muzzle(a, b.set(shot.muzzle[0], shot.muzzle[1], shot.muzzle[2]));
    const direction = b.set(shot.direction[0], shot.direction[1], shot.direction[2]);
    events.emit('shotFired', { shooterId: body.id, weapon: def, muzzle, direction, local: false });

    const player = this.ctx.player;
    let whizzed = !player.alive;
    const count = Math.min(shot.ends.length, def.pellets);
    for (let i = 0; i < count; i++) {
      const end = shot.ends[i]!;
      const to = c.set(end[0], end[1], end[2]);
      events.emit('bulletTrace', { shooterId: body.id, weapon: def, from: muzzle, to, local: false });
      // The shooter's machine knows what was hit; this one only needs the mark on the wall.
      const length = direction.subVectors(to, muzzle).length();
      if (length < 0.2) continue;
      direction.divideScalar(length);
      const hit = this.ctx.world.raycast(muzzle, direction, length + 0.4);
      if (hit && hit.distance > length - 0.6) events.emit('bulletImpact', { shooterId: body.id, weapon: def, hit });
      if (whizzed) continue;
      player.eyePosition(head);
      closestPointOnSegment(muzzle, to, head, nearest);
      const gap = nearest.distanceToSquared(head);
      // A round that stopped in the player is a hit, not a near miss.
      if (gap < NEAR_MISS_RADIUS * NEAR_MISS_RADIUS && to.distanceToSquared(head) > 1) {
        whizzed = true;
        events.emit('nearMiss', { point: nearest, direction, weapon: def });
      }
    }
  }

  private onRemoteHit(hit: Extract<NetEvent, { t: 'hit' }>, now: number): void {
    const def = WEAPON_DEFS[hit.weapon];
    const player = this.ctx.player;
    let target: Combatant | undefined;
    if (hit.target === this.myWire) {
      // A partner cannot hurt a partner; in a duel only the opponent can. A co-op guest is also shot at by the host's bots.
      const fromPeer = hit.attacker === this.peerWire && !this.coop;
      // Only a bot the host has announced: an unknown id would also get a fresh rate allowance each time.
      const fromBot = this.role === 'guest' && this.coop && this.proxies.get(hit.attacker) !== undefined;
      if (fromPeer || fromBot) target = player;
    } else if (this.role === 'host' && this.coop && hit.attacker === this.peerWire && hit.target >= WIRE_BOT_BASE) {
      target = this.localOf(hit.target);
    }
    if (!target || !target.alive || !this.gate(hit.attacker).allowHit(def, now)) return;
    const amount = capDamage(def, hit.amount);
    if (amount <= 0) return;
    const attacker = this.localOf(hit.attacker);
    const point = a.set(hit.p[0], hit.p[1], hit.p[2]);
    const direction = b.set(hit.d[0], hit.d[1], hit.d[2]);
    if (direction.lengthSq() < 1e-6) direction.set(0, 0, -1);
    direction.normalize();
    if (target === player) this.lastHurt.copy(direction);
    target.applyDamage({ amount, zone: hit.zone, attackerId: attacker?.id ?? NOBODY, weaponId: hit.weapon, point, direction });
    if (target !== player) {
      // Let the host see and hear the guest's hit land on the bot.
      this.ctx.events.emit('combatantHit', {
        weapon: def,
        targetId: target.id,
        attackerId: attacker?.id ?? NOBODY,
        hit: { distance: 0, zone: hit.zone, point },
        direction,
        fatal: !target.alive,
      });
    }
  }

  private onRemoteDeath(death: Extract<NetEvent, { t: 'death' }>): void {
    const direction = a.set(death.d[0], death.d[1], death.d[2]);
    if (direction.lengthSq() < 1e-6) direction.set(0, 0, -1);
    // A partner cannot be killed by this player, so their death never counts as this player's kill.
    const killer = this.coop && death.victim === this.peerWire && death.killer === this.myWire ? undefined : this.localOf(death.killer);
    if (death.victim === this.peerWire) {
      if (death.life <= this.lastPeerDeathLife) return;
      this.lastPeerDeathLife = death.life;
      this.partnerDeaths++;
      this.remote.die(direction, death.life);
      this.ctx.events.emit('died', { victimId: this.remote.id, killerId: killer?.id ?? NOBODY, weaponId: death.weapon, headshot: death.headshot });
      return;
    }
    if (this.role !== 'guest' || !this.coop) return;
    const proxy = this.proxies.get(death.victim);
    if (!proxy || proxy.endedLife >= 0) return;
    proxy.die(direction, 0);
    this.ctx.events.emit('died', { victimId: proxy.id, killerId: killer?.id ?? NOBODY, weaponId: death.weapon, headshot: death.headshot });
  }

  private onRemoteAction(action: Extract<NetEvent, { t: 'action' }>, now: number): void {
    const body = this.remoteActor(action.actor);
    if (!body || !this.actionGate.take(now)) return;
    this.ctx.events.emit('weaponAction', {
      shooterId: body.id,
      weapon: WEAPON_DEFS[action.weapon],
      stage: action.stage,
      position: body.chestPosition(a),
      local: false,
    });
  }

  private onHostMatch(match: Extract<NetEvent, { t: 'match' }>): void {
    const previous = this.hostMatch;
    this.hostMatch = { wave: match.wave, enemies: match.enemies };
    this.partnerKills = match.hostKills;
    if (previous && match.wave > previous.wave) this.hooks.waveStarted();
    if (match.result !== '') this.hooks.endMatch(match.result);
  }

  /** The host is gone: clear its bots away. Returns how many were alive. */
  dropProxies(): number {
    return this.proxies.clear();
  }

  /** The other player is gone: take their body out of the world and stop sending. */
  dropRemote(): void {
    if (this.remoteGone) return;
    this.remoteGone = true;
    this.pendingShot = null;
    this.ctx.combat.remove(this.remote.id);
    this.ctx.engine.scene.remove(this.remote.visual.root);
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.proxies.dispose();
    this.dropRemote();
    this.remote.dispose();
  }
}
