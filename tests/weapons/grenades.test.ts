import { BoxGeometry, Matrix4, PlaneGeometry, Vector3 } from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../../src/core/events';
import { Combat } from '../../src/game/combat';
import type { Combatant, CombatantHit, DamageInfo, GameContext, GameEvents, Team } from '../../src/game/contracts';
import { GRENADE } from '../../src/weapons/grenade-math';
import { GRENADE_DEF, GRENADE_ID, createGrenades } from '../../src/weapons/grenades';
import { CollisionWorld } from '../../src/world/collision';

const world = new CollisionWorld();

beforeAll(() => {
  const ground = new PlaneGeometry(200, 200);
  ground.rotateX(-Math.PI / 2);
  world.addCollider(ground, new Matrix4(), 'concrete');
  // A 3 m wall at z = -5, from x = -5 to x = 5.
  world.addCollider(new BoxGeometry(10, 3, 0.4), new Matrix4().makeTranslation(0, 1.5, -5), 'concrete');
  world.build();
});

class Dummy implements Combatant {
  readonly velocity = new Vector3();
  readonly crouching = false;
  readonly position: Vector3;
  alive = true;
  health = 100;
  readonly damage: DamageInfo[] = [];

  constructor(
    readonly id: number,
    readonly kind: Combatant['kind'],
    readonly team: Team,
    readonly name: string,
    x: number,
    z: number,
    private readonly events?: EventBus<GameEvents>,
  ) {
    this.position = new Vector3(x, 0, z);
  }

  eyePosition(target: Vector3): Vector3 {
    return target.copy(this.position).setY(1.6);
  }

  hitTest(): CombatantHit | null {
    return null;
  }

  applyDamage(info: DamageInfo): void {
    if (!this.alive) return;
    this.damage.push({ ...info, point: info.point.clone(), direction: info.direction.clone() });
    this.health = Math.max(0, this.health - info.amount);
    if (this.health > 0) return;
    this.alive = false;
    this.events?.emit('died', { victimId: this.id, killerId: info.attackerId, weaponId: info.weaponId, headshot: false });
  }
}

function setup() {
  const events = new EventBus<GameEvents>();
  const combat = new Combat(() => world);
  const player = new Dummy(combat.allocateId(), 'local', 'alpha', 'You', 0, 20, events);
  combat.add(player);
  const ctx = { events, combat, world, player, time: 0 } as unknown as GameContext;
  const grenades = createGrenades(ctx);
  const log: string[] = [];
  const deaths: GameEvents['died'][] = [];
  const hits: { targetId: number; fatal: boolean; weapon: string }[] = [];
  let blast: Vector3 | null = null;
  events.on('grenadeThrown', (e) => log.push(`thrown:${e.local}`));
  events.on('grenadeBounced', () => log.push('bounce'));
  events.on('grenadeExploded', (e) => {
    log.push(`exploded:${e.local}`);
    blast = e.position.clone();
  });
  events.on('died', (e) => deaths.push({ ...e }));
  events.on('combatantHit', (e) => hits.push({ targetId: e.targetId, fatal: e.fatal, weapon: e.weapon.id }));
  const add = (kind: Combatant['kind'], team: Team, name: string, x: number, z: number): Dummy => {
    const dummy = new Dummy(combat.allocateId(), kind, team, name, x, z, events);
    combat.add(dummy);
    return dummy;
  };
  const run = (seconds: number): void => {
    for (let t = 0; t < seconds; t += 1 / 60) grenades.update(1 / 60);
  };
  return { events, combat, player, grenades, log, deaths, hits, add, run, blast: () => blast };
}

/** Drop a grenade so that it lies still at (x, z) until it goes off. */
function place(grenades: ReturnType<typeof setup>['grenades'], owner: Combatant, x: number, z: number, authoritative = true): void {
  grenades.launch(owner, new Vector3(x, GRENADE.radius + 0.01, z), new Vector3(), authoritative);
}

describe('grenades', () => {
  it('flies, bounces and goes off when the fuse runs out, not before', () => {
    const { grenades, player, log, run, blast } = setup();
    grenades.launch(player, new Vector3(20, 1.5, 20), new Vector3(12, 3, 0), true);
    expect(log).toEqual(['thrown:true']);
    run(GRENADE.fuse - 0.1);
    expect(log.filter((entry) => entry === 'bounce').length).toBeGreaterThanOrEqual(1);
    expect(log.some((entry) => entry.startsWith('exploded'))).toBe(false);
    expect(grenades.flights.filter((flight) => flight.active)).toHaveLength(1);
    run(0.2);
    expect(log[log.length - 1]).toBe('exploded:true');
    expect(grenades.flights.some((flight) => flight.active)).toBe(false);
    expect(blast()!.x).toBeGreaterThan(28);
  });

  it('kills an enemy inside the lethal radius and credits the thrower', () => {
    const { grenades, player, add, run, deaths, hits } = setup();
    const near = add('bot', 'bravo', 'Near', 2, 0);
    const mid = add('bot', 'bravo', 'Mid', 5.5, 0);
    const far = add('bot', 'bravo', 'Far', 12, 0);
    place(grenades, player, 0, 0);
    run(GRENADE.fuse + 0.1);
    expect(near.alive).toBe(false);
    expect(near.damage[0]?.attackerId).toBe(player.id);
    expect(near.damage[0]?.weaponId).toBe(GRENADE_ID);
    expect(near.damage[0]?.zone).toBe('torso');
    expect(deaths).toEqual([{ victimId: near.id, killerId: player.id, weaponId: GRENADE_ID, headshot: false }]);
    expect(mid.alive).toBe(true);
    expect(mid.health).toBeLessThan(100);
    expect(mid.health).toBeGreaterThan(0);
    expect(far.damage).toHaveLength(0);
    expect(hits).toEqual([
      { targetId: near.id, fatal: true, weapon: GRENADE_DEF.id },
      { targetId: mid.id, fatal: false, weapon: GRENADE_DEF.id },
    ]);
  });

  it('pushes the victim away from the blast', () => {
    const { grenades, player, add, run } = setup();
    const bot = add('bot', 'bravo', 'East', 2, 0);
    place(grenades, player, 0, 0);
    run(GRENADE.fuse + 0.1);
    expect(bot.damage[0]!.direction.x).toBeGreaterThan(0.5);
    expect(bot.damage[0]!.direction.length()).toBeCloseTo(1, 5);
  });

  it('is blocked by a wall', () => {
    const { grenades, player, add, run } = setup();
    const open = add('bot', 'bravo', 'Open', 1.5, -3.5);
    const covered = add('bot', 'bravo', 'Covered', 0, -6.2);
    place(grenades, player, 0, -4);
    run(GRENADE.fuse + 0.1);
    expect(open.alive).toBe(false);
    expect(covered.damage).toHaveLength(0);
    expect(covered.health).toBe(100);
  });

  it('hurts the thrower, with no hit marker for it', () => {
    const { grenades, player, run, deaths, hits } = setup();
    place(grenades, player, player.position.x + 1, player.position.z);
    run(GRENADE.fuse + 0.1);
    expect(player.alive).toBe(false);
    expect(deaths).toEqual([{ victimId: player.id, killerId: player.id, weaponId: GRENADE_ID, headshot: false }]);
    expect(hits).toHaveLength(0);
  });

  it("spares the thrower's own side, like bullets do", () => {
    const { grenades, player, add, run } = setup();
    const friend = add('remote', 'alpha', 'Friend', 1.5, 0);
    const enemy = add('bot', 'bravo', 'Enemy', -1.5, 0);
    place(grenades, player, 0, 0);
    run(GRENADE.fuse + 0.1);
    expect(friend.damage).toHaveLength(0);
    expect(enemy.alive).toBe(false);
  });

  it("only shows the other player's grenade: no damage, and it goes off when told", () => {
    const { grenades, player, add, run, log, blast } = setup();
    const peer = add('remote', 'bravo', 'Peer', 3, 0);
    place(grenades, peer, 2, 0, false);
    expect(log).toEqual(['thrown:false']);
    run(GRENADE.fuse + 0.5);
    // The fuse has run out here, but the thrower's machine has not said so yet.
    expect(log.some((entry) => entry.startsWith('exploded'))).toBe(false);
    grenades.detonate(peer.id, new Vector3(2.3, 0.05, 0.2));
    expect(log[log.length - 1]).toBe('exploded:false');
    expect(blast()!.x).toBeCloseTo(2.3, 5);
    expect(player.damage).toHaveLength(0);
    expect(peer.damage).toHaveLength(0);
    // A second word about the same grenade does nothing.
    grenades.detonate(peer.id, new Vector3(2.3, 0.05, 0.2));
    expect(log.filter((entry) => entry.startsWith('exploded'))).toHaveLength(1);
  });

  it('sets a shown grenade off by itself if the word never comes, still without damage', () => {
    const { grenades, add, run, log } = setup();
    const peer = add('remote', 'bravo', 'Peer', 3, 0);
    const bystander = add('bot', 'alpha', 'Bystander', 2.5, 0);
    place(grenades, peer, 2, 0, false);
    run(GRENADE.fuse + 2);
    expect(log[log.length - 1]).toBe('exploded:false');
    expect(bystander.damage).toHaveLength(0);
  });

  it('ignores a blast position far from where the grenade is shown', () => {
    const { grenades, add, run, blast } = setup();
    const peer = add('remote', 'bravo', 'Peer', 3, 0);
    place(grenades, peer, 2, 0, false);
    run(1);
    grenades.detonate(peer.id, new Vector3(60, 0, 60));
    expect(blast()!.x).toBeCloseTo(2, 1);
  });

  it('clear removes grenades in flight without a blast', () => {
    const { grenades, player, add, run, log } = setup();
    const bot = add('bot', 'bravo', 'Near', 1, 0);
    place(grenades, player, 0, 0);
    run(1);
    grenades.clear();
    run(3);
    expect(log.some((entry) => entry.startsWith('exploded'))).toBe(false);
    expect(bot.damage).toHaveLength(0);
  });
});
