import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ui/styles/hud-extras.css', () => ({}));
const { killNote } = await import('../../src/ui/hud/extras');

describe('killNote', () => {
  it('names a plain kill', () => {
    expect(killNote(false, 1, 20)).toBe('Enemy down');
  });
  it('adds headshot and long range', () => {
    expect(killNote(true, 1, 84.4)).toBe('Enemy down · Headshot · 84 m');
  });
  it('names streaks', () => {
    expect(killNote(false, 2, 10)).toBe('Double kill');
    expect(killNote(true, 3, 10)).toBe('Triple kill · Headshot');
    expect(killNote(false, 9, 10)).toBe('9 in a row');
  });
});
