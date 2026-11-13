import { describe, expect, it } from 'vitest';
import { duelBotSide, duelBotsHere } from '../../src/net/rules';

describe('duelBotSide', () => {
  it('puts the bot on its owner\'s team on each machine, where each player is alpha', () => {
    expect(duelBotSide('host', 'host').team).toBe('alpha');
    expect(duelBotSide('host', 'guest').team).toBe('bravo');
    expect(duelBotSide('guest', 'guest').team).toBe('alpha');
    expect(duelBotSide('guest', 'host').team).toBe('bravo');
  });

  it('dresses the bot like its owner on both machines: the host in alpha, the guest in bravo', () => {
    expect(duelBotSide('host', 'host').uniform).toBe('alpha');
    expect(duelBotSide('host', 'guest').uniform).toBe('alpha');
    expect(duelBotSide('guest', 'host').uniform).toBe('bravo');
    expect(duelBotSide('guest', 'guest').uniform).toBe('bravo');
  });
});

describe('duelBotsHere', () => {
  it('runs one bot on the host only, and none when nobody has one', () => {
    expect(duelBotsHere('guest', 'host')).toBe(1);
    expect(duelBotsHere('host', 'host')).toBe(1);
    expect(duelBotsHere('guest', 'guest')).toBe(0);
    expect(duelBotsHere('none', 'host')).toBe(0);
  });
});
