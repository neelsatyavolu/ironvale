import { describe, expect, it } from 'vitest';
import type { KillFeedEntry } from '../../src/game/contracts';
import { feedKey, trimKillFeed } from '../../src/ui/killfeed';

const entry = (time: number, killer = 'You', victim = `Bot ${time}`): KillFeedEntry => ({
  killer,
  victim,
  weapon: 'm4a1',
  headshot: false,
  time,
});

describe('trimKillFeed', () => {
  it('drops entries older than the display time', () => {
    const rows = trimKillFeed([entry(1), entry(5), entry(9)], 10, 6, 4);
    expect(rows.map((row) => row.time)).toEqual([5, 9]);
  });

  it('keeps only the newest rows when there are too many', () => {
    const rows = trimKillFeed([entry(1), entry(2), entry(3), entry(4), entry(5)], 5, 60, 3);
    expect(rows.map((row) => row.time)).toEqual([3, 4, 5]);
  });

  it('returns nothing for an empty feed or a zero limit', () => {
    expect(trimKillFeed([], 10, 6, 4)).toEqual([]);
    expect(trimKillFeed([entry(9)], 10, 6, 0)).toEqual([]);
  });

  it('keeps an entry right at the age limit out', () => {
    expect(trimKillFeed([entry(4)], 10, 6, 4)).toEqual([]);
  });

  it('does not change the list it was given', () => {
    const feed = Object.freeze([entry(1), entry(9)]);
    trimKillFeed(feed, 10, 6, 1);
    expect(feed.length).toBe(2);
  });
});

describe('feedKey', () => {
  it('is stable for the same kill and different for another', () => {
    expect(feedKey(entry(3))).toBe(feedKey(entry(3)));
    expect(feedKey(entry(3))).not.toBe(feedKey(entry(3, 'You', 'Someone else')));
    expect(feedKey(entry(3))).not.toBe(feedKey(entry(4)));
  });
});
