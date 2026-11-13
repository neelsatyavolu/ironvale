import { describe, expect, it } from 'vitest';
import { issuedWeapons } from '../../src/weapons/loadout';

describe('issuedWeapons', () => {
  it('keeps the M7 for Veteran and Elite', () => {
    expect(issuedWeapons({ mode: 'skirmish', difficulty: 'recruit' })).toEqual(['m4a1', 'mp5', 'm24', 'm249']);
    expect(issuedWeapons({ mode: 'survival', difficulty: 'regular' })).not.toContain('m7');
    expect(issuedWeapons({ mode: 'skirmish', difficulty: 'veteran' })).toContain('m7');
    expect(issuedWeapons({ mode: 'coop', difficulty: 'elite' })).toContain('m7');
  });
  it('leaves it out of a duel, which has no difficulty level', () => {
    expect(issuedWeapons({ mode: 'duel', difficulty: 'elite' })).not.toContain('m7');
  });
  it('issues the SCAR-H alongside the M7, in slot order', () => {
    expect(issuedWeapons({ mode: 'skirmish', difficulty: 'regular' })).not.toContain('scarh');
    expect(issuedWeapons({ mode: 'skirmish', difficulty: 'veteran' })).toEqual(['m4a1', 'mp5', 'm24', 'm249', 'm7', 'scarh']);
    expect(issuedWeapons({ mode: 'coop', difficulty: 'elite' })).toContain('scarh');
    expect(issuedWeapons({ mode: 'duel', difficulty: 'elite' })).not.toContain('scarh');
  });
});
