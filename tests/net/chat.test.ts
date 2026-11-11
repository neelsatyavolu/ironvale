import { describe, expect, it } from 'vitest';
import { encodeEvent, parseEvent } from '../../src/net/events';
import { CHAT_LENGTH, sanitizeChat } from '../../src/net/limits';
import { MINIMAP, revealAge } from '../../src/ui/hud/minimap-model';

describe('chat lines', () => {
  it('keeps ordinary text and trims it', () => {
    expect(sanitizeChat('  nice shot  ')).toBe('nice shot');
  });

  it('folds line breaks and control characters into spaces', () => {
    expect(sanitizeChat('one\ntwo\u0000three​')).toBe('one two three');
  });

  it('cuts a long line and rejects an empty one', () => {
    expect(sanitizeChat('x'.repeat(500))).toHaveLength(CHAT_LENGTH);
    expect(sanitizeChat('   ')).toBe('');
    expect(sanitizeChat(42)).toBe('');
  });

  it('survives the wire and is cleaned on the way in', () => {
    expect(parseEvent(encodeEvent({ t: 'chat', text: 'on your left' }))).toEqual({ t: 'chat', text: 'on your left' });
    expect(parseEvent(JSON.stringify({ t: 'chat', text: '<b>hi</b>\n' }))).toEqual({ t: 'chat', text: '<b>hi</b>' });
    expect(parseEvent(JSON.stringify({ t: 'chat', text: '' }))).toBeNull();
  });
});

describe('duel reveal on the minimap', () => {
  it('shows nobody before the first interval', () => {
    expect(revealAge(0)).toBe(Infinity);
    expect(revealAge(MINIMAP.revealEvery - 0.1)).toBe(Infinity);
  });

  it('shows the opponent for a moment every interval', () => {
    expect(revealAge(MINIMAP.revealEvery)).toBe(0);
    expect(revealAge(MINIMAP.revealEvery + 1)).toBeCloseTo(1);
    expect(revealAge(MINIMAP.revealEvery + MINIMAP.revealSeconds + 0.1)).toBe(Infinity);
    expect(revealAge(MINIMAP.revealEvery * 3 + 0.5)).toBeCloseTo(0.5);
  });
});
