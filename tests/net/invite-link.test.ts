import { describe, expect, it } from 'vitest';
import { inviteLink, isRoomCode, roomCodeFrom } from '../../src/net/room-code';

describe('invite links', () => {
  it('puts the room code on the page address and drops other parameters', () => {
    expect(inviteLink('ABC234', 'https://ironvale.n3el.dev/play/?map=harbor#x')).toBe('https://ironvale.n3el.dev/play/?join=ABC234');
  });

  it('reads the code back out of a pasted link', () => {
    expect(roomCodeFrom(' https://ironvale.n3el.dev/play/?join=abc234 ')).toBe('ABC234');
    expect(roomCodeFrom('https://x.dev/play/?q=high&join=ABC-234')).toBe('ABC234');
  });

  it('still accepts a bare code typed with spaces or dashes', () => {
    expect(roomCodeFrom('abc 234')).toBe('ABC234');
    expect(isRoomCode(roomCodeFrom('abc-234'))).toBe(true);
  });

  it('does not make a code out of other text', () => {
    expect(isRoomCode(roomCodeFrom('https://example.com/'))).toBe(false);
    expect(isRoomCode(roomCodeFrom(''))).toBe(false);
  });
});
