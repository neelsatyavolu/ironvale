import { describe, expect, it } from 'vitest';
import { PRIORITY, VoiceBook, type VoiceRequest } from '../../src/audio/voices';

const request = (overrides: Partial<VoiceRequest> = {}): VoiceRequest => ({
  priority: PRIORITY.normal,
  group: '',
  groupCap: 0,
  positional: true,
  distance: 10,
  loop: false,
  ...overrides,
});

describe('VoiceBook.acquire', () => {
  it('uses free slots until the cap, then steals the oldest voice of the lowest priority', () => {
    const book = new VoiceBook(6, 3);
    const a = book.acquire(request({ priority: PRIORITY.high }), 0);
    const b = book.acquire(request({ priority: PRIORITY.low }), 0);
    const c = book.acquire(request({ priority: PRIORITY.low }), 0);
    expect([a.slot, b.slot, c.slot]).toEqual([0, 1, 2]);
    expect(book.playing).toBe(3);

    const d = book.acquire(request(), 1);
    expect(d.stolen).toEqual([b.slot]);
    expect(d.slot).toBe(3);
    expect(book.playing).toBe(3);

    const e = book.acquire(request(), 1);
    expect(e.stolen).toEqual([c.slot]);
  });

  it('steals oldest first among equals', () => {
    const book = new VoiceBook(8, 4);
    const slots = [0, 1, 2, 3].map(() => book.acquire(request(), 0).slot);
    const order = [0, 1, 2, 3].map(() => book.acquire(request(), 1).stolen[0]);
    expect(order).toEqual(slots);
  });

  it('drops a sound that is less important than everything playing', () => {
    const book = new VoiceBook(4, 2);
    book.acquire(request({ priority: PRIORITY.high }), 0);
    book.acquire(request({ priority: PRIORITY.high }), 0);
    const result = book.acquire(request({ priority: PRIORITY.low }), 1);
    expect(result.slot).toBe(-1);
    expect(result.stolen).toEqual([]);
    expect(book.playing).toBe(2);
  });

  it('never steals a loop', () => {
    const book = new VoiceBook(4, 2);
    const loop = book.acquire(request({ priority: PRIORITY.low, loop: true }), 0);
    const shot = book.acquire(request({ priority: PRIORITY.normal }), 0);
    const next = book.acquire(request({ priority: PRIORITY.critical }), 1);
    expect(next.stolen).toEqual([shot.slot]);
    expect(book.voices[loop.slot]!.active).toBe(true);
  });

  it('keeps a stolen slot out of reuse until its fade has finished', () => {
    const book = new VoiceBook(3, 2);
    book.acquire(request(), 0);
    book.acquire(request(), 0);
    const third = book.acquire(request(), 1);
    expect(third.stolen).toEqual([0]);
    expect(third.slot).toBe(2);
    book.release(third.slot, 1, 0.04);
    expect(book.acquire(request(), 1.01).slot).toBe(-1);
    expect(book.acquire(request(), 1.05).slot).toBe(0);
  });

  it('caps a group by stopping its oldest voice, leaving other groups alone', () => {
    const book = new VoiceBook(10, 8);
    const tails = [0, 1, 2].map(() => book.acquire(request({ group: 'tail:1', groupCap: 3 }), 0).slot);
    const other = book.acquire(request({ group: 'tail:2', groupCap: 3 }), 0).slot;
    const fourth = book.acquire(request({ group: 'tail:1', groupCap: 3 }), 1);
    expect(fourth.stolen).toEqual([tails[0]]);
    expect(book.voices[other]!.active).toBe(true);
    expect(book.voices.filter((voice) => voice.active && voice.group === 'tail:1')).toHaveLength(3);
  });
});

describe('VoiceBook.assignHrtf', () => {
  it('gives HRTF to the nearest voices only', () => {
    const book = new VoiceBook(12, 12);
    const far = book.acquire(request({ distance: 200 }), 0).slot;
    const near = book.acquire(request({ distance: 2 }), 0).slot;
    const middle = book.acquire(request({ distance: 30 }), 0).slot;
    book.assignHrtf(2);
    expect(book.voices[near]!.hrtf).toBe(true);
    expect(book.voices[middle]!.hrtf).toBe(true);
    expect(book.voices[far]!.hrtf).toBe(false);
  });

  it('prefers the newer of two voices at the same distance', () => {
    const book = new VoiceBook(12, 12);
    const older = book.acquire(request({ distance: 10 }), 0).slot;
    const newer = book.acquire(request({ distance: 10 }), 0).slot;
    book.assignHrtf(1);
    expect(book.voices[newer]!.hrtf).toBe(true);
    expect(book.voices[older]!.hrtf).toBe(false);
  });

  it('never gives HRTF to the player\'s own sounds and reports only changes', () => {
    const book = new VoiceBook(12, 12);
    const own = book.acquire(request({ positional: false, distance: 0 }), 0).slot;
    const other = book.acquire(request({ distance: 5 }), 0).slot;
    expect(book.assignHrtf(8)).toEqual([other]);
    expect(book.voices[own]!.hrtf).toBe(false);
    expect(book.assignHrtf(8)).toEqual([]);
  });

  it('holds at most the cap however many voices play', () => {
    const book = new VoiceBook(40, 32);
    for (let i = 0; i < 20; i++) book.acquire(request({ distance: i }), 0);
    book.assignHrtf(8);
    expect(book.voices.filter((voice) => voice.hrtf)).toHaveLength(8);
    book.assignHrtf(0);
    expect(book.voices.filter((voice) => voice.hrtf)).toHaveLength(0);
  });
});
