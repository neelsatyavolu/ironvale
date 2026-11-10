import { describe, expect, it } from 'vitest';
import creditsFile from '../../CREDITS.md?raw';
import { buildCredits, creditsMarkdown, type CreditAsset } from '../../src/ui/credits-model';

/** Every manifest, in file-name order: the same set and order the game and scripts/credits.mjs read. */
const files = import.meta.glob<{ assets: CreditAsset[] }>('../../assets/*.json', { eager: true, import: 'default' });
const manifest: CreditAsset[] = Object.keys(files)
  .sort()
  .flatMap((path) => files[path]?.assets ?? []);

const asset = (patch: Partial<CreditAsset>): CreditAsset => ({
  id: 'x',
  kind: 'model',
  license: 'CC0',
  source: 'https://polyhaven.com/a/thing',
  ...patch,
});

describe('buildCredits', () => {
  it('always returns the five groups in order', () => {
    expect(buildCredits([]).map((group) => group.id)).toEqual(['models', 'sounds', 'textures', 'fonts', 'libraries']);
  });

  it('puts each kind in its group', () => {
    const groups = buildCredits([
      asset({ id: 'a', kind: 'model' }),
      asset({ id: 'b', kind: 'sound', source: 'https://freesound.org/s/1/' }),
      asset({ id: 'c', kind: 'pbr' }),
      asset({ id: 'd', kind: 'hdri' }),
      asset({ id: 'e', kind: 'texture' }),
    ]);
    expect(groups.map((group) => group.count)).toEqual([1, 1, 3, 3, 2]);
  });

  it('shows a CC-BY credit line once however many files share it', () => {
    const credit = '"Steps" by Someone, https://freesound.org/s/9/, CC-BY 4.0';
    const [, sounds] = buildCredits([
      asset({ id: 's1', kind: 'sound', license: 'CC-BY 4.0', source: 'https://freesound.org/s/9/', credit }),
      asset({ id: 's2', kind: 'sound', license: 'CC-BY 4.0', source: 'https://freesound.org/s/9/', credit }),
    ]);
    expect(sounds?.credited).toEqual([{ text: credit, url: 'https://freesound.org/s/9/', count: 2 }]);
    expect(sounds?.thanks).toEqual([]);
  });

  it('still names the licence and source when a CC-BY entry has no credit line', () => {
    const [models] = buildCredits([asset({ id: 'mdl-x', license: 'CC-BY 4.0', source: 'https://example.org/x' })]);
    expect(models?.credited[0]?.text).toBe('mdl-x, CC-BY 4.0, https://example.org/x');
  });

  it('thanks CC0 sources by site and counts distinct originals', () => {
    const [, sounds] = buildCredits([
      asset({ id: 's1', kind: 'sound', source: 'https://freesound.org/s/1/' }),
      asset({ id: 's2', kind: 'sound', source: 'https://freesound.org/s/1/' }),
      asset({ id: 's3', kind: 'sound', source: 'https://freesound.org/s/2/' }),
      asset({ id: 's4', kind: 'sound', source: 'scripts/process-audio.mjs' }),
    ]);
    expect(sounds?.thanks).toEqual([
      { name: 'Freesound', url: 'https://freesound.org', licence: 'CC0', note: '3 sounds cut from 2 recordings' },
      { name: 'Ironvale', url: '', licence: 'CC0', note: '1 sound synthesised for the game' },
    ]);
  });

  it('falls back to the host name for a site it does not know', () => {
    const [models] = buildCredits([asset({ source: 'https://example.org/a/b' })]);
    expect(models?.thanks[0]).toMatchObject({ name: 'example.org', url: 'https://example.org' });
  });
});

describe('the shipped manifests', () => {
  const groups = buildCredits(manifest);

  it('give every CC-BY entry a credit line with its source address', () => {
    const missing = manifest.filter((entry) => entry.license !== 'CC0' && !entry.credit?.includes(entry.source));
    expect(missing.map((entry) => entry.id)).toEqual([]);
  });

  it('use only the two licences the project allows', () => {
    expect([...new Set(manifest.map((entry) => entry.license))].sort()).toEqual(['CC-BY 4.0', 'CC0']);
  });

  it('credit all nine CC-BY models', () => {
    const text = groups[0]?.credited.map((line) => line.text).join('\n') ?? '';
    for (const author of ['doctortex', 'MrM0lten', 'e.belous', 'Michael Karel', '8sianDude', 'Sky_Hunter', 'Domevans', 'DJMaesen']) {
      expect(text).toContain(author);
    }
  });

  it('match CREDITS.md (run "node scripts/credits.mjs" after changing a manifest)', () => {
    expect(creditsFile).toBe(creditsMarkdown(groups));
  });
});
