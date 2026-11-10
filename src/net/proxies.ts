import { createSoldier } from '../characters/index';
import type { DamageInfo, GameContext, SoldierVisual } from '../game/contracts';
import type { BotState, NetEvent } from './protocol';
import { RemoteSoldier } from './remote-soldier';

/** Bots arrive 12 times a second, so they are shown further in the past than the other player. */
const BOT_DELAY_MS = 170;
const MAX_EXTRAPOLATION_MS = 250;
const CORPSE_SECONDS = 20;
export const MAX_PROXIES = 96;
/** Bots run above this speed; it picks the louder footstep. */
const BOT_RUN_SPEED = 4.5;

/**
 * A co-op guest's stand-ins for the host's bots: remote combatants on team
 * bravo that follow the host's snapshots. Hits on them are forwarded to the
 * host through `onDamage`; they fall when the host says so.
 */
export class BotProxies {
  private readonly byWire = new Map<number, RemoteSoldier>();
  private readonly byLocal = new Map<number, RemoteSoldier>();
  private readonly spare: SoldierVisual[] = [];

  constructor(
    private readonly ctx: GameContext,
    private readonly onDamage: (target: RemoteSoldier, info: DamageInfo) => void,
  ) {}

  get alive(): number {
    let count = 0;
    for (const proxy of this.byWire.values()) if (proxy.alive) count++;
    return count;
  }

  get(wire: number): RemoteSoldier | undefined {
    return this.byWire.get(wire);
  }

  /** By this machine's combat id. */
  local(id: number): RemoteSoldier | undefined {
    return this.byLocal.get(id);
  }

  values(): IterableIterator<RemoteSoldier> {
    return this.byWire.values();
  }

  spawn(spawn: Extract<NetEvent, { t: 'botSpawn' }>): void {
    if (this.byWire.has(spawn.id) || this.byWire.size >= MAX_PROXIES) return;
    const { ctx } = this;
    const visual = this.spare.pop() ?? createSoldier(ctx.assets, 'bravo');
    visual.revive();
    const proxy = new RemoteSoldier(ctx, {
      id: ctx.combat.allocateId(),
      wireId: spawn.id,
      team: 'bravo',
      name: spawn.name,
      visual,
      weapon: spawn.weapon,
      delayMs: BOT_DELAY_MS,
      maxExtrapolationMs: MAX_EXTRAPOLATION_MS,
      deriveVelocity: true,
      onDamage: this.onDamage,
    });
    proxy.place(spawn.p[0], spawn.p[1], spawn.p[2], spawn.yaw);
    this.byWire.set(spawn.id, proxy);
    this.byLocal.set(proxy.id, proxy);
    ctx.combat.add(proxy);
    ctx.engine.scene.add(visual.root);
    ctx.events.emit('spawned', { combatantId: proxy.id });
  }

  /** A snapshot from the host. `time` is on this machine's clock. Bots nobody announced are ignored. */
  push(time: number, bots: readonly BotState[]): void {
    for (const bot of bots) {
      const proxy = this.byWire.get(bot.id);
      if (!proxy) continue;
      proxy.push(
        { time, epoch: 0, x: bot.x, y: bot.y, z: bot.z, vx: 0, vy: 0, vz: 0, yaw: bot.yaw, pitch: bot.pitch },
        {
          crouching: bot.crouching,
          aiming: bot.aiming,
          reloading: bot.reloading,
          running: bot.speed > BOT_RUN_SPEED,
          onGround: true,
          alive: bot.alive,
          health: 100,
          weapon: bot.weapon,
        },
        0,
      );
    }
  }

  update(dt: number, now: number): void {
    for (const [wire, proxy] of this.byWire) {
      proxy.update(dt, now);
      if (!proxy.alive && proxy.corpseTime > CORPSE_SECONDS) this.retire(wire, proxy);
    }
  }

  /** Take every stand-in out of the world. Returns how many were alive. */
  clear(): number {
    const alive = this.alive;
    for (const [wire, proxy] of [...this.byWire]) this.retire(wire, proxy);
    return alive;
  }

  dispose(): void {
    this.clear();
    for (const visual of this.spare) visual.dispose();
    this.spare.length = 0;
  }

  private retire(wire: number, proxy: RemoteSoldier): void {
    this.byWire.delete(wire);
    this.byLocal.delete(proxy.id);
    this.ctx.combat.remove(proxy.id);
    this.ctx.engine.scene.remove(proxy.visual.root);
    this.spare.push(proxy.visual);
  }
}
