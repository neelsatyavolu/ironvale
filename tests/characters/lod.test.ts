import { describe, expect, it } from 'vitest';
import { LOD, VisibilityTracker, poseInterval, shouldPose } from '../../src/characters/lod';

describe('poseInterval', () => {
  it('poses a nearby visible soldier every frame', () => {
    expect(poseInterval(true, 5)).toBe(1);
  });

  it('poses less often with distance', () => {
    expect(poseInterval(true, LOD.midDistance + 1)).toBeGreaterThan(1);
    expect(poseInterval(true, LOD.farDistance + 1)).toBeGreaterThan(poseInterval(true, LOD.midDistance + 1));
  });

  it('keeps an unseen soldier ticking slowly for its shadow and muzzle position', () => {
    expect(poseInterval(false, 5)).toBe(LOD.hiddenInterval);
    expect(poseInterval(false, 500)).toBe(LOD.hiddenInterval);
  });
});

describe('shouldPose', () => {
  it('fires once per interval', () => {
    const hits = Array.from({ length: 12 }, (_, frame) => shouldPose(frame, 0, 4)).filter(Boolean);
    expect(hits.length).toBe(3);
  });

  it('staggers soldiers so they do not all update on the same frame', () => {
    const frames = [0, 1, 2, 3].map((slot) => [0, 1, 2, 3].find((frame) => shouldPose(frame, slot, 4)));
    expect(new Set(frames).size).toBe(4);
  });
});

describe('VisibilityTracker', () => {
  it('starts visible so a new soldier is posed straight away', () => {
    expect(new VisibilityTracker().visible).toBe(true);
  });

  it('turns hidden a few frames after the last time it was drawn', () => {
    const tracker = new VisibilityTracker();
    tracker.seen(12);
    tracker.tick();
    expect(tracker.visible).toBe(true);
    expect(tracker.distance).toBe(12);
    for (let i = 0; i < LOD.hiddenAfterFrames + 1; i++) tracker.tick();
    expect(tracker.visible).toBe(false);
  });

  it('comes back as soon as it is drawn again', () => {
    const tracker = new VisibilityTracker();
    for (let i = 0; i < 10; i++) tracker.tick();
    tracker.seen(30);
    expect(tracker.visible).toBe(true);
  });
});
