/** The asset manifest for the MP5 gun model (assets/guns-a.json). */
import { describe, expect, it } from 'vitest';
import manifest from '../../../assets/guns-a.json';

/** Lazy loaders keyed by path; only the keys are used, to see which files exist. */
const PROCESSED = Object.keys(import.meta.glob('../../../public/assets/local/guns/*.glb'));

const AUTHORS: Record<string, string> = {
  'mdl-gun-mp5': 'Michael Karel',
};

describe('guns-a manifest', () => {
  it('lists one model per weapon', () => {
    expect(manifest.assets.map((asset) => asset.id).sort()).toEqual(Object.keys(AUTHORS).sort());
    for (const asset of manifest.assets) expect(asset.kind).toBe('model');
  });

  it('credits every CC-BY model with its author, licence and source', () => {
    for (const asset of manifest.assets) {
      expect(asset.license).toBe('CC-BY 4.0');
      expect(asset.source).toMatch(/^https:\/\/sketchfab\.com\/3d-models\//);
      expect(asset.credit).toContain(AUTHORS[asset.id]);
      expect(asset.credit).toContain('CC BY 4.0');
      expect(asset.credit).toMatch(/https:\/\/sketchfab\.com\/\w+/);
    }
  });

  it('points at processed files that are committed to the repo', () => {
    for (const asset of manifest.assets) {
      const file = asset.files.gltf;
      expect(file.local).toBe(true);
      expect('url' in file).toBe(false);
      expect(PROCESSED).toContain(`../../../public/assets/local/${file.path}`);
    }
  });
});
