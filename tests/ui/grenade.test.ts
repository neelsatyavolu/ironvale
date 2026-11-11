import { describe, expect, it } from 'vitest';
import { grenadeHint } from '../../src/ui/hud/grenade';

describe('grenadeHint', () => {
  it('names the key while there is a grenade to throw', () => {
    expect(grenadeHint(1, false, 'G')).toBe('Hold G');
  });

  it('says how to throw while aiming', () => {
    expect(grenadeHint(1, true, 'G')).toBe('Release G to throw');
  });

  it('says it is gone once thrown', () => {
    expect(grenadeHint(0, false, 'G')).toBe('Used');
  });
});
