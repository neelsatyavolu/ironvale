import { describe, expect, it } from 'vitest';
import { GrenadeHand } from '../../src/weapons/grenade-hand';

const DT = 1 / 60;

function input(held: boolean, cancel = false, allowed = true) {
  return { held, cancel, allowed };
}

describe('GrenadeHand', () => {
  it('starts a match with one grenade and none before', () => {
    const hand = new GrenadeHand();
    expect(hand.count).toBe(0);
    hand.restock();
    expect(hand.count).toBe(1);
  });

  it('aims while the key is held and throws on release', () => {
    const hand = new GrenadeHand();
    hand.restock();
    expect(hand.update(DT, input(true))).toBe(false);
    expect(hand.aiming).toBe(true);
    for (let i = 0; i < 30; i++) expect(hand.update(DT, input(true))).toBe(false);
    expect(hand.count).toBe(1);
    expect(hand.lowered).toBeCloseTo(1, 5);
    expect(hand.update(DT, input(false))).toBe(true);
    expect(hand.aiming).toBe(false);
    expect(hand.count).toBe(0);
  });

  it('has only one: a second hold does nothing', () => {
    const hand = new GrenadeHand();
    hand.restock();
    hand.update(DT, input(true));
    expect(hand.update(DT, input(false))).toBe(true);
    expect(hand.update(DT, input(true))).toBe(false);
    expect(hand.aiming).toBe(false);
    expect(hand.update(DT, input(false))).toBe(false);
    expect(hand.count).toBe(0);
  });

  it('cancels without using the grenade, and needs a fresh press to aim again', () => {
    const hand = new GrenadeHand();
    hand.restock();
    hand.update(DT, input(true));
    expect(hand.update(DT, input(true, true))).toBe(false);
    expect(hand.aiming).toBe(false);
    expect(hand.count).toBe(1);
    // Still holding the key after the cancel: nothing happens, and letting go does not throw.
    expect(hand.update(DT, input(true))).toBe(false);
    expect(hand.aiming).toBe(false);
    expect(hand.update(DT, input(false))).toBe(false);
    expect(hand.count).toBe(1);
    hand.update(DT, input(true));
    expect(hand.aiming).toBe(true);
  });

  it('does not start while the hands are busy, and drops the aim when they become busy', () => {
    const hand = new GrenadeHand();
    hand.restock();
    hand.update(DT, input(true, false, false));
    expect(hand.aiming).toBe(false);
    hand.update(DT, input(false));
    hand.update(DT, input(true));
    expect(hand.aiming).toBe(true);
    hand.update(DT, input(true, false, false));
    expect(hand.aiming).toBe(false);
    expect(hand.count).toBe(1);
  });

  it('keeps the gun down for a moment after the throw, then raises it', () => {
    const hand = new GrenadeHand();
    hand.restock();
    for (let i = 0; i < 30; i++) hand.update(DT, input(true));
    hand.update(DT, input(false));
    expect(hand.lowered).toBeGreaterThan(0.5);
    for (let i = 0; i < 90; i++) hand.update(DT, input(false));
    expect(hand.lowered).toBe(0);
  });

  it('is not refilled by a reset of the hands, only by a restock', () => {
    const hand = new GrenadeHand();
    hand.restock();
    hand.update(DT, input(true));
    hand.update(DT, input(false));
    hand.cancel();
    expect(hand.count).toBe(0);
    hand.restock();
    expect(hand.count).toBe(1);
  });

  it('a cancel while aiming (death, respawn) keeps the grenade', () => {
    const hand = new GrenadeHand();
    hand.restock();
    hand.update(DT, input(true));
    hand.cancel();
    expect(hand.aiming).toBe(false);
    expect(hand.lowered).toBe(0);
    expect(hand.count).toBe(1);
  });
});
