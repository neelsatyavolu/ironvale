import { Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { Squad, type BotState, type SquadMember } from '../../src/ai/blackboard';
import { DIFFICULTY, DIFFICULTY_ORDER } from '../../src/ai/difficulty';

function member(state: BotState, alive = true, coverNode = -1): SquadMember {
  return { alive, state, coverNode };
}

describe('Squad blackboard', () => {
  it('counts who is holding the front, pushing and flanking', () => {
    const squad = new Squad();
    squad.tally([member('cover', true, 7), member('strafe'), member('push'), member('flank'), member('patrol'), member('cover', false)]);
    expect(squad.alive).toBe(5);
    expect(squad.engaging).toBe(2);
    expect(squad.pushing).toBe(1);
    expect(squad.flanking).toBe(1);
    expect(squad.takenCover.slice(0, 6)).toEqual([7, -1, -1, -1, -1, -1]);
  });

  it('never lets the whole squad advance at once, on any difficulty', () => {
    for (const level of DIFFICULTY_ORDER) {
      for (let size = 2; size <= 16; size++) {
        const squad = new Squad();
        const members = Array.from({ length: size }, () => member('cover'));
        squad.tally(members);
        let pushing = 0;
        for (const m of members) {
          if (!squad.canPush(DIFFICULTY[level].pushFraction)) break;
          (m as { state: BotState }).state = 'push';
          pushing++;
          squad.tally(members);
        }
        expect(pushing).toBeGreaterThanOrEqual(1);
        expect(pushing).toBeLessThan(size);
        expect(pushing).toBeLessThanOrEqual(Math.max(1, Math.round(size * DIFFICULTY[level].pushFraction)));
      }
    }
  });

  it('lets a lone survivor push', () => {
    const squad = new Squad();
    squad.tally([member('strafe')]);
    expect(squad.canPush(0.2)).toBe(true);
  });

  it('only sends a flanker when at least two mates hold the front, and only a few at a time', () => {
    const squad = new Squad();
    squad.tally([member('cover'), member('patrol'), member('patrol'), member('patrol')]);
    expect(squad.canFlank()).toBe(false);
    squad.tally([member('cover'), member('strafe'), member('hold'), member('patrol')]);
    expect(squad.canFlank()).toBe(true);
    squad.tally([member('cover'), member('strafe'), member('hold'), member('flank')]);
    expect(squad.canFlank()).toBe(false);
  });

  it('shares the last known position and when contact began', () => {
    const squad = new Squad();
    expect(squad.hasContact(10, 5)).toBe(false);
    squad.report(3, new Vector3(1, 0, 2), new Vector3(10, 0, 20), 10);
    squad.report(4, new Vector3(5, 0, 2), new Vector3(11, 0, 21), 12);
    expect(squad.lastKnown.x).toBe(11);
    expect(squad.contactTime).toBe(12);
    expect(squad.contactStart).toBe(10);
    expect(squad.spotterId).toBe(4);
    expect(squad.hasContact(13, 5)).toBe(true);
    expect(squad.hasContact(30, 5)).toBe(false);
    // A sighting after a long gap starts a new contact.
    squad.report(3, new Vector3(1, 0, 2), new Vector3(0, 0, 0), 40);
    expect(squad.contactStart).toBe(40);
  });

  it('rate-limits callouts by kind', () => {
    const squad = new Squad();
    expect(squad.tryCallout('spotted', 1)).toBe(true);
    expect(squad.tryCallout('spotted', 2)).toBe(false);
    expect(squad.tryCallout('reloading', 2)).toBe(true);
    expect(squad.tryCallout('spotted', 6)).toBe(true);
    expect(squad.tryCallout('death', 6)).toBe(true);
    expect(squad.tryCallout('death', 6.1)).toBe(true);
  });
});
