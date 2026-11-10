import { describe, expect, it } from 'vitest';
import { TokenBucket, WeaponGate, capDamage, maxHitDamage, sanitizeName } from '../../src/net/limits';
import { ROOM_CODE_LENGTH, isRoomCode, makeRoomCode, normalizeRoomCode } from '../../src/net/room-code';
import { pickDuelSpawn, duelResult } from '../../src/net/rules';
import { WEAPON_DEFS } from '../../src/weapons/defs';

describe('sanitizeName', () => {
  it('keeps ordinary names', () => {
    expect(sanitizeName('Ada')).toBe('Ada');
    expect(sanitizeName('Zoë_99')).toBe('Zoë_99');
  });

  it('strips markup, control characters and extra spaces', () => {
    expect(sanitizeName('<script>x</script>')).toBe('scriptxscript');
    expect(sanitizeName('  a \u0000‮  b\n')).toBe('a b');
  });

  it('cuts at 16 characters and falls back when nothing is left', () => {
    expect(sanitizeName('abcdefghijklmnopqrstuvwxyz')).toBe('abcdefghijklmnop');
    expect(sanitizeName('<<<>>>')).toBe('Player');
    expect(sanitizeName(42 as unknown as string)).toBe('Player');
    expect(sanitizeName('', 'Friend')).toBe('Friend');
  });
});

describe('damage limits', () => {
  it('allows a headshot at point-blank range and nothing above it', () => {
    const def = WEAPON_DEFS.m4a1;
    const most = maxHitDamage(def);
    expect(most).toBeCloseTo(def.damage * def.headshotMultiplier, 6);
    expect(capDamage(def, most)).toBe(most);
    expect(capDamage(def, 10_000)).toBe(most);
    expect(capDamage(def, 12)).toBe(12);
  });

  it('turns a hit that is not a positive number into no damage', () => {
    const def = WEAPON_DEFS.m24;
    expect(capDamage(def, -4)).toBe(0);
    expect(capDamage(def, Number.NaN)).toBe(0);
    expect(capDamage(def, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('TokenBucket', () => {
  it('lets a burst through, then holds to the rate', () => {
    const bucket = new TokenBucket(10, 3);
    expect([bucket.take(0), bucket.take(0), bucket.take(0), bucket.take(0)]).toEqual([true, true, true, false]);
    expect(bucket.take(100)).toBe(true);
    expect(bucket.take(100)).toBe(false);
    expect(bucket.take(5000)).toBe(true);
  });

  it('does not bank more than its size, and survives a clock that goes backwards', () => {
    const bucket = new TokenBucket(10, 2);
    expect(bucket.take(60_000, 2)).toBe(true);
    expect(bucket.take(60_000)).toBe(false);
    expect(bucket.take(1000)).toBe(false);
  });
});

describe('WeaponGate', () => {
  it('passes shots at the rate of fire and drops a faster stream', () => {
    const gate = new WeaponGate();
    const def = WEAPON_DEFS.m4a1;
    const interval = 60_000 / def.roundsPerMinute;
    let passed = 0;
    for (let i = 0; i < 40; i++) if (gate.allowShot(def, i * interval)) passed++;
    expect(passed).toBe(40);

    const fast = new WeaponGate();
    let through = 0;
    // Ten times the real rate for two seconds.
    for (let i = 0; i < 270; i++) if (fast.allowShot(def, i * (interval / 10))) through++;
    expect(through).toBeLessThan(60);
    expect(through).toBeGreaterThan(20);
  });

  it('counts every pellet of a shotgun as a hit but only one shot', () => {
    const gate = new WeaponGate();
    const def = WEAPON_DEFS.r870;
    expect(gate.allowShot(def, 0)).toBe(true);
    let hits = 0;
    for (let i = 0; i < def.pellets; i++) if (gate.allowHit(def, 0)) hits++;
    expect(hits).toBe(def.pellets);
  });

  it('holds a bolt action to its slow rate', () => {
    const gate = new WeaponGate();
    const def = WEAPON_DEFS.m24;
    let passed = 0;
    for (let i = 0; i < 50; i++) if (gate.allowHit(def, i * 20)) passed++;
    expect(passed).toBeLessThanOrEqual(4);
  });
});

describe('room codes', () => {
  it('makes six characters from the unambiguous alphabet', () => {
    let n = 0;
    const code = makeRoomCode(() => (n++ * 0.137) % 1);
    expect(code).toHaveLength(ROOM_CODE_LENGTH);
    expect(isRoomCode(code)).toBe(true);
    expect(code).not.toMatch(/[ILO01]/);
  });

  it('tidies what a person types', () => {
    expect(normalizeRoomCode(' k7m-2qx ')).toBe('K7M2QX');
    expect(isRoomCode(normalizeRoomCode('k7m 2qx'))).toBe(true);
    expect(isRoomCode('K7M2Q')).toBe(false);
    expect(isRoomCode('K7M2QO')).toBe(false);
  });
});

describe('duel rules', () => {
  const spawns = [
    { x: 0, z: 0 },
    { x: 30, z: 0 },
    { x: -10, z: 40 },
  ];

  it('picks the spawn furthest from the opponent', () => {
    expect(pickDuelSpawn(spawns, { x: 29, z: 1 })).toBe(2);
    expect(pickDuelSpawn(spawns, { x: -10, z: 39 })).toBe(1);
  });

  it('returns -1 with no spawns', () => {
    expect(pickDuelSpawn([], { x: 0, z: 0 })).toBe(-1);
  });

  it('ends at the kill target', () => {
    expect(duelResult(9, 9, 10)).toBeNull();
    expect(duelResult(10, 4, 10)).toBe('won');
    expect(duelResult(4, 10, 10)).toBe('lost');
  });
});
