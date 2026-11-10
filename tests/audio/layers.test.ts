import { describe, expect, it } from 'vitest';
import { activeReverb, chooseShotLayers, CLOSE_UNTIL, DISTANT_FROM } from '../../src/audio/layers';
import type { ReverbPreset } from '../../src/world/types';

const PRESETS: ReverbPreset[] = ['open-field', 'forest', 'street', 'industrial', 'interior'];

describe('chooseShotLayers', () => {
  it('gives the shooter the close take, sub thump and mechanism, never the distant take', () => {
    const layers = chooseShotLayers({ local: true, distance: 0, environment: 'open-field' });
    expect(layers.close).toBe(1);
    expect(layers.distant).toBe(0);
    expect(layers.sub).toBeGreaterThan(0.5);
    expect(layers.mech).toBeGreaterThan(0);
  });

  it('keeps the sub thump for the shooter only', () => {
    for (const distance of [1, 20, 300]) {
      expect(chooseShotLayers({ local: false, distance, environment: 'street' }).sub).toBe(0);
    }
  });

  it('crossfades close into distant with range at constant power', () => {
    const near = chooseShotLayers({ local: false, distance: CLOSE_UNTIL - 5, environment: 'open-field' });
    const far = chooseShotLayers({ local: false, distance: DISTANT_FROM + 50, environment: 'open-field' });
    expect(near.close).toBeCloseTo(1);
    expect(near.distant).toBeCloseTo(0);
    expect(far.close).toBeCloseTo(0);
    expect(far.distant).toBeCloseTo(1);
    let previousClose = Infinity;
    for (let distance = 0; distance <= 250; distance += 5) {
      const layers = chooseShotLayers({ local: false, distance, environment: 'open-field' });
      expect(layers.close ** 2 + layers.distant ** 2).toBeCloseTo(1, 6);
      expect(layers.close).toBeLessThanOrEqual(previousClose);
      previousClose = layers.close;
    }
  });

  it('uses the recorded outdoor tail most in the open and least indoors', () => {
    const tail = (environment: ReverbPreset) => chooseShotLayers({ local: true, distance: 0, environment }).tail;
    expect(tail('open-field')).toBeGreaterThan(tail('forest'));
    expect(tail('forest')).toBeGreaterThan(tail('industrial'));
    expect(tail('industrial')).toBeGreaterThan(tail('interior'));
    expect(tail('interior')).toBeLessThan(0.3);
  });

  it('sends more to the reverb the more enclosed the place is', () => {
    const send = (environment: ReverbPreset) => chooseShotLayers({ local: true, distance: 0, environment }).reverbSend;
    expect(send('interior')).toBeGreaterThan(send('industrial'));
    expect(send('industrial')).toBeGreaterThan(send('street'));
    expect(send('street')).toBeGreaterThan(send('forest'));
    expect(send('forest')).toBeGreaterThan(send('open-field'));
  });

  it('darkens the tail in the forest', () => {
    const forest = chooseShotLayers({ local: true, distance: 0, environment: 'forest' });
    const open = chooseShotLayers({ local: true, distance: 0, environment: 'open-field' });
    expect(forest.tailCutoff).toBeLessThan(open.tailCutoff);
  });

  it('lets bystanders hear the action only within a few metres', () => {
    expect(chooseShotLayers({ local: false, distance: 2, environment: 'street' }).mech).toBeGreaterThan(0);
    expect(chooseShotLayers({ local: false, distance: 15, environment: 'street' }).mech).toBe(0);
  });

  it('returns finite, non-negative gains for every environment and range', () => {
    for (const environment of PRESETS) {
      for (const distance of [0, 10, 80, 400, 2000]) {
        for (const local of [true, false]) {
          for (const value of Object.values(chooseShotLayers({ local, distance, environment }))) {
            expect(Number.isFinite(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
  });
});

describe('activeReverb', () => {
  it('uses the map preset outside and the zone preset under a roof', () => {
    expect(activeReverb('forest', false, 'industrial')).toBe('forest');
    expect(activeReverb('forest', true, 'industrial')).toBe('industrial');
    expect(activeReverb('forest', true, null)).toBe('interior');
  });
});
