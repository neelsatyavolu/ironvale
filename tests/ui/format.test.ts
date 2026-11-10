import { describe, expect, it } from 'vitest';
import { accuracyPercent, formatClock, respawnCountdown } from '../../src/ui/format';

describe('formatClock', () => {
  it('writes minutes and padded seconds', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(9.9)).toBe('0:09');
    expect(formatClock(75)).toBe('1:15');
    expect(formatClock(3725)).toBe('62:05');
  });

  it('treats bad input as zero', () => {
    expect(formatClock(-3)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });
});

describe('accuracyPercent', () => {
  it('is null before any shot', () => {
    expect(accuracyPercent(0, 0)).toBeNull();
  });

  it('rounds to a whole percentage', () => {
    expect(accuracyPercent(1, 3)).toBe(33);
    expect(accuracyPercent(30, 30)).toBe(100);
  });

  it('never exceeds 100', () => {
    expect(accuracyPercent(12, 9)).toBe(100);
  });
});

describe('respawnCountdown', () => {
  it('counts whole seconds down and never below one while waiting', () => {
    expect(respawnCountdown(10, 10, 3)).toBe(3);
    expect(respawnCountdown(10, 11.2, 3)).toBe(2);
    expect(respawnCountdown(10, 12.95, 3)).toBe(1);
    expect(respawnCountdown(10, 14, 3)).toBe(1);
  });
});

