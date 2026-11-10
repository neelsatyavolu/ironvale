import { describe, expect, it, vi } from 'vitest';
import { WEAPON_DEFS } from '../../src/weapons/defs';

vi.mock('../../src/ui/styles/picker.css', () => ({}));
const { weaponStats } = await import('../../src/ui/hud/picker');
const stat = (id: keyof typeof WEAPON_DEFS, label: string): number =>
  weaponStats(WEAPON_DEFS[id]).find((s) => s.label === label)!.value;

describe('weaponStats', () => {
  it('keeps every bar between 0 and 1', () => {
    for (const def of Object.values(WEAPON_DEFS)) {
      for (const s of weaponStats(def)) {
        expect(s.value).toBeGreaterThanOrEqual(0);
        expect(s.value).toBeLessThanOrEqual(1);
      }
    }
  });
  it('ranks the guns the way they play', () => {
    expect(stat('m24', 'Range')).toBeGreaterThan(stat('m4a1', 'Range'));
    expect(stat('m4a1', 'Range')).toBeGreaterThan(stat('r870', 'Range'));
    expect(stat('r870', 'Damage')).toBeGreaterThan(stat('m4a1', 'Damage'));
    expect(stat('m1911', 'Handling')).toBeGreaterThan(stat('m249', 'Handling'));
    expect(stat('mp5', 'Rate of fire')).toBeGreaterThan(stat('m24', 'Rate of fire'));
  });
});
