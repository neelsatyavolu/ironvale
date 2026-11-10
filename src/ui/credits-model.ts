/**
 * Turns the asset manifests into the credits shown in the game and written to
 * CREDITS.md (scripts/credits.mjs). No imports: Node runs this file as it is.
 */

/** The part of a manifest entry the credits need. `AssetEntry` satisfies it. */
export interface CreditAsset {
  readonly id: string;
  readonly kind: string;
  readonly license: string;
  readonly source: string;
  readonly credit?: string;
}

export type CreditGroupId = 'models' | 'sounds' | 'textures' | 'fonts' | 'libraries';

/** An attribution a licence requires, shown in full. */
export interface CreditLine {
  readonly text: string;
  readonly url: string;
  /** How many manifest entries carry this line. */
  readonly count: number;
}

/** A source that asks for no credit, a font or a library. */
export interface CreditThanks {
  readonly name: string;
  readonly url: string;
  readonly licence: string;
  readonly note: string;
}

export interface CreditGroup {
  readonly id: CreditGroupId;
  readonly title: string;
  /** Manifest entries in the group, or the number of rows for fonts and libraries. */
  readonly count: number;
  readonly credited: readonly CreditLine[];
  readonly thanks: readonly CreditThanks[];
}

export const CC_BY_URL = 'https://creativecommons.org/licenses/by/4.0/';
const FREE_LICENCE = 'CC0';

/** `cut` is set where several files are cut from one original, so the count of originals is worth showing. */
const ASSET_GROUPS: readonly { id: CreditGroupId; title: string; kinds: readonly string[]; one: string; many: string; cut?: boolean }[] = [
  { id: 'models', title: 'Models', kinds: ['model'], one: 'model', many: 'models' },
  { id: 'sounds', title: 'Sounds', kinds: ['sound'], one: 'sound', many: 'sounds', cut: true },
  { id: 'textures', title: 'Textures and skies', kinds: ['pbr', 'texture', 'hdri'], one: 'texture set or sky', many: 'texture sets and skies' },
];

const SITE_NAMES: Readonly<Record<string, string>> = {
  'polyhaven.com': 'Poly Haven',
  'freesound.org': 'Freesound',
  'opengameart.org': 'OpenGameArt',
  'ambientcg.com': 'ambientCG',
};

/** Source pages that are one named work, credited by that name. */
const NAMED_PAGES: Readonly<Record<string, { name: string; by: string }>> = {
  'https://opengameart.org/content/the-free-firearm-sound-library': {
    name: 'The Free Firearm Sound Library',
    by: 'recorded by Ben Jaszczak, Brian Nelson, Kevin Heras and Matthew Nanney',
  },
};

const FONTS: readonly CreditThanks[] = [
  { name: 'Newsreader', url: 'https://github.com/productiontype/Newsreader', licence: 'OFL 1.1', note: 'Production Type' },
  { name: 'Geist', url: 'https://github.com/vercel/geist-font', licence: 'OFL 1.1', note: 'The Geist Project Authors' },
  { name: 'Geist Mono', url: 'https://github.com/vercel/geist-font', licence: 'OFL 1.1', note: 'The Geist Project Authors' },
];

const LIBRARIES: readonly CreditThanks[] = [
  { name: 'three.js', url: 'https://threejs.org', licence: 'MIT', note: 'Rendering, on WebGPU and WebGL 2' },
  { name: 'three-mesh-bvh', url: 'https://github.com/gkjohnson/three-mesh-bvh', licence: 'MIT', note: 'Collision and bullet ray casts' },
  { name: 'Tauri', url: 'https://tauri.app', licence: 'MIT or Apache 2.0', note: 'The Mac app' },
];

function creditedLines(entries: readonly CreditAsset[]): CreditLine[] {
  const lines = new Map<string, CreditLine>();
  for (const entry of entries) {
    const text = entry.credit ?? `${entry.id}, ${entry.license}, ${entry.source}`;
    const seen = lines.get(text);
    lines.set(text, { text, url: entry.source, count: (seen?.count ?? 0) + 1 });
  }
  return [...lines.values()];
}

function hostOf(source: string): string | null {
  try {
    return new URL(source).host.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function thanksRows(entries: readonly CreditAsset[], one: string, many: string, countOriginals: boolean): CreditThanks[] {
  const buckets = new Map<string, CreditAsset[]>();
  for (const entry of entries) {
    const key = NAMED_PAGES[entry.source] ? entry.source : (hostOf(entry.source) ?? '');
    buckets.set(key, [...(buckets.get(key) ?? []), entry]);
  }
  return [...buckets].map(([key, bucket]) => {
    const amount = `${bucket.length} ${bucket.length === 1 ? one : many}`;
    const page = NAMED_PAGES[key];
    if (page) return { name: page.name, url: key, licence: FREE_LICENCE, note: `${amount}, ${page.by}` };
    // A source that is not a web address is one of the project's own scripts.
    if (key === '') return { name: 'Ironvale', url: '', licence: FREE_LICENCE, note: `${amount} synthesised for the game` };
    const originals = new Set(bucket.map((entry) => entry.source)).size;
    const cut = countOriginals && originals < bucket.length ? ` cut from ${originals} ${originals === 1 ? 'recording' : 'recordings'}` : '';
    return { name: SITE_NAMES[key] ?? key, url: `https://${key}`, licence: FREE_LICENCE, note: amount + cut };
  });
}

/** The five groups, always in the same order. Asset groups come from `manifest` alone. */
export function buildCredits(manifest: readonly CreditAsset[]): CreditGroup[] {
  const assetGroups = ASSET_GROUPS.map(({ id, title, kinds, one, many, cut }): CreditGroup => {
    const entries = manifest.filter((entry) => kinds.includes(entry.kind));
    return {
      id,
      title,
      count: entries.length,
      credited: creditedLines(entries.filter((entry) => entry.license !== FREE_LICENCE)),
      thanks: thanksRows(entries.filter((entry) => entry.license === FREE_LICENCE), one, many, cut === true),
    };
  });
  return [
    ...assetGroups,
    { id: 'fonts', title: 'Fonts', count: FONTS.length, credited: [], thanks: FONTS },
    { id: 'libraries', title: 'Libraries', count: LIBRARIES.length, credited: [], thanks: LIBRARIES },
  ];
}

/** A credit line as a sentence, saying how many files it covers when that is more than one. */
export function creditSentence(line: CreditLine): string {
  const text = /[.!?]$/.test(line.text) ? line.text : `${line.text}.`;
  return line.count > 1 ? `${text} Used for ${line.count} files.` : text;
}

/** The same credits as a Markdown document. */
export function creditsMarkdown(groups: readonly CreditGroup[]): string {
  const out = [
    '# Credits',
    '',
    'Generated from `assets/*.json` by `node scripts/credits.mjs`. Do not edit by hand: change the manifest and run the script again. The Credits screen in the game shows the same list.',
    '',
    `Ironvale is built from work other people gave away. Entries under CC BY 4.0 (${CC_BY_URL}) are credited in full, with the changes made to each. CC0 sources ask for no credit and are thanked by site.`,
  ];
  for (const group of groups) {
    out.push('', `## ${group.title}`, '');
    for (const line of group.credited) out.push(`- ${creditSentence(line)}`);
    if (group.credited.length > 0 && group.thanks.length > 0) out.push('');
    for (const row of group.thanks) {
      const where = row.url ? ` (${row.url})` : '';
      out.push(`- ${row.name}${where}, ${row.licence}: ${row.note}`);
    }
  }
  return `${out.join('\n')}\n`;
}
