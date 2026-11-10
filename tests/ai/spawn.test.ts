import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { assignSpawns, inViewCone, orderSpawns } from '../../src/ai/spawn';

const spawns = [
  { position: new Vector3(0, 0, -10), yaw: 0 },
  { position: new Vector3(0, 0, -40), yaw: 0 },
  { position: new Vector3(30, 0, 0), yaw: 0 },
  { position: new Vector3(0, 0, 25), yaw: 0 },
];
const player = new Vector3(0, 0, 0);

describe('spawn choice', () => {
  it('orders spawns furthest from the player first when none is in view', () => {
    const order = orderSpawns(spawns, player, () => false);
    expect(order.indices).toEqual([1, 2, 3, 0]);
    expect(order.hidden).toBe(4);
  });

  it('puts spawns the player can see last, however far they are', () => {
    const order = orderSpawns(spawns, player, (index) => index === 1 || index === 0);
    expect(order.indices).toEqual([2, 3, 1, 0]);
    expect(order.hidden).toBe(2);
  });

  it('fills hidden spawns before any spawn in view', () => {
    const order = orderSpawns(spawns, player, (index) => index === 1);
    const picks = assignSpawns(6, order, 4);
    expect(picks).toHaveLength(6);
    expect(picks.slice(0, 3)).toEqual([2, 3, 0]);
    expect(picks).not.toContain(1);
  });

  it('uses a spawn in view only when the hidden ones are full', () => {
    const order = orderSpawns(spawns, player, (index) => index !== 2);
    const picks = assignSpawns(6, order, 4);
    expect(picks.slice(0, 4)).toEqual([2, 2, 2, 2]);
    expect(picks.slice(4)).toEqual([1, 3]);
  });

  it('still places everyone when every spawn is in view or the squad outnumbers the slots', () => {
    const order = orderSpawns(spawns, player, () => true);
    expect(assignSpawns(3, order, 4)).toEqual([1, 2, 3]);
    expect(assignSpawns(40, orderSpawns(spawns, player, () => false), 4)).toHaveLength(40);
    expect(assignSpawns(2, orderSpawns([], player, () => false), 4)).toEqual([]);
  });

  it('tests whether a point is inside the player view cone', () => {
    const half = (65 * Math.PI) / 180;
    expect(inViewCone(player, 0, new Vector3(0, 0, -30), half)).toBe(true);
    expect(inViewCone(player, 0, new Vector3(0, 0, 30), half)).toBe(false);
    expect(inViewCone(player, Math.PI, new Vector3(0, 0, 30), half)).toBe(true);
    expect(inViewCone(player, 0, new Vector3(-30, 0, -5), half)).toBe(false);
  });
});
