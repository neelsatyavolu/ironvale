import { describe, expect, it } from 'vitest';
import { assignRoles, ROLES, type BotRole } from '../../src/ai/roles';
import { WEAPON_DEFS } from '../../src/weapons/defs';

function tally(roles: readonly BotRole[]): Record<BotRole, number> {
  const counts: Record<BotRole, number> = { rifleman: 0, rusher: 0, breacher: 0, marksman: 0, gunner: 0 };
  for (const role of roles) counts[role]++;
  return counts;
}

describe('roles', () => {
  it('arms each role with its weapon', () => {
    expect(ROLES.rifleman.weapon).toBe('m4a1');
    expect(ROLES.rusher.weapon).toBe('mp5');
    expect(ROLES.breacher.weapon).toBe('r870');
    expect(ROLES.marksman.weapon).toBe('m24');
    expect(ROLES.gunner.weapon).toBe('m249');
    for (const role of Object.values(ROLES)) expect(WEAPON_DEFS[role.weapon]).toBeDefined();
  });

  it('gives the marksman range, the breacher none, and the gunner long bursts', () => {
    expect(ROLES.marksman.idealRange).toBeGreaterThan(ROLES.rifleman.idealRange);
    expect(ROLES.breacher.idealRange).toBeLessThan(ROLES.rusher.idealRange);
    expect(ROLES.gunner.burstMin).toBeGreaterThan(ROLES.rifleman.burstMax);
    expect(ROLES.marksman.burstMax).toBe(1);
    expect(ROLES.marksman.pauseMin).toBeGreaterThan(1);
    expect(ROLES.gunner.holds && ROLES.marksman.holds).toBe(true);
    expect(ROLES.rusher.pushes && ROLES.breacher.pushes).toBe(true);
  });

  it('fields mostly riflemen, one marksman per six and one gunner per eight', () => {
    for (const count of [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 24]) {
      const roles = assignRoles(count);
      const counts = tally(roles);
      expect(roles).toHaveLength(count);
      expect(counts.marksman).toBe(Math.floor(count / 6));
      expect(counts.gunner).toBe(Math.floor(count / 8));
      expect(counts.rifleman).toBeGreaterThanOrEqual(counts.rusher);
      expect(counts.rifleman).toBeGreaterThanOrEqual(counts.breacher + counts.marksman);
      expect(counts.breacher).toBeLessThanOrEqual(Math.max(1, count / 6));
    }
    expect(tally(assignRoles(12))).toEqual({ rifleman: 5, rusher: 3, breacher: 1, marksman: 2, gunner: 1 });
    expect(tally(assignRoles(3))).toEqual({ rifleman: 3, rusher: 0, breacher: 0, marksman: 0, gunner: 0 });
  });

  it('spreads the specialists through the squad instead of bunching them', () => {
    const roles = assignRoles(12);
    expect(roles[0]).toBe('rifleman');
    expect(new Set(roles.slice(0, 6)).size).toBeGreaterThanOrEqual(3);
  });
});
