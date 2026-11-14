/**
 * M10b: writes the data and answers the native Metal HUD (IronvaleUI/HUD) is checked against, straight from src/.
 *
 *   npx vitest run --config native/Tools/vitest.config.ts native/Tools/ui-fixtures/hud-fixtures.test.ts
 *   HUD_FIXTURES_CHECK=1 ...   fail instead of writing when an output differs from what is committed
 *
 * Outputs (all committed):
 *   native/Tools/ui-fixtures/fixtures/web-hud-fixtures.json            test cases: inputs and the web's answers
 *   native/IronvaleKit/Sources/IronvaleUI/Generated/WebHUDData.swift  runtime data: module-private HUD constants
 *                                                                       (extracted, never hand-copied) and the
 *                                                                       asset manifest the credits are built from
 *   native/IronvaleApp/Resources/HUD/minimap-<map>.bin                 the minimap layout raster per map: the web's
 *                                                                       buildLayout over the bots' NavGrid, built on
 *                                                                       the map's exported collision soup
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Box3, Vector3 } from 'three/webgpu';
import { expect, it } from 'vitest';
import creditsFile from '../../../CREDITS.md?raw';
import { buildNavGrid } from '../../../src/ai/navgrid';
import { BINDING_PRESETS } from '../../../src/core/input';
import type { KillFeedEntry } from '../../../src/game/contracts';
import { sanitizeName } from '../../../src/net/limits';
import { buildCredits, creditsMarkdown, type CreditAsset } from '../../../src/ui/credits-model';
import { damageAngle, healthEffects, unwrapAngle } from '../../../src/ui/damage';
import { respawnCountdown, rulesOf } from '../../../src/ui/format';
import { killNote } from '../../../src/ui/hud/extras';
import { grenadeHint } from '../../../src/ui/hud/grenade';
import { buildLayout, horizontalHalfFov, MINIMAP, revealAge, shotAge, toMap, type MapPoint, type NavSource } from '../../../src/ui/hud/minimap-model';
import { weaponStats } from '../../../src/ui/hud/picker';
import { feedKey, trimKillFeed } from '../../../src/ui/killfeed';
import { keyName } from '../../../src/ui/keys';
import { WEAPON_DEFS } from '../../../src/weapons/defs';
import { RESERVED_NOTE } from '../../../src/weapons/loadout';
import { extractConsts } from '../contract-export/extract-consts';
import { mapWorld } from '../sim-fixtures/worlds';

const out = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const REPO = out('../../../');
const FIXTURES = out('./fixtures/web-hud-fixtures.json');
const SWIFT = out('../../IronvaleKit/Sources/IronvaleUI/Generated/WebHUDData.swift');
const LAYOUT_DIR = out('../../IronvaleApp/Resources/HUD/');
const CHECK = process.env.HUD_FIXTURES_CHECK === '1';
/** The maps a match can be played on, plus the developer range M4 brings up first. */
const LAYOUT_MAPS = ['range', 'railyard', 'harbor', 'headworks'];

const drift: string[] = [];
function emit(path: string, data: string | Uint8Array): void {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  if (CHECK) {
    if (!existsSync(path) || !readFileSync(path).equals(bytes)) drift.push(path);
    return;
  }
  writeFileSync(path, bytes);
}

/** Deterministic numbers for the generated cases. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

/** Constants the HUD modules keep private, read from the source by the contract exporter's parser. */
function hudConstants(): Record<string, unknown> {
  const x = (file: string, names: string[]) => extractConsts(REPO, file, names);
  return {
    hud: x('src/ui/hud/hud.ts', ['LOW_HEALTH', 'RESPAWN_SECONDS', 'TOAST_MS', 'FIRE_MODES', 'WEAPON_CLASSES']),
    reticle: x('src/ui/hud/reticle.ts', ['ARC_COUNT', 'ARC_SECONDS', 'ARC_MERGE', 'ARC_REDRAW', 'HIT_MS', 'KILL_MS']),
    scope: x('src/ui/hud/scope.ts', ['DOTS', 'DOT_RADIUS', 'POST_START']),
    feed: x('src/ui/hud/feed.ts', ['MAX_ROWS', 'MAX_AGE']),
    extras: x('src/ui/hud/extras.ts', ['KILL_NOTE_MS', 'STREAK_SECONDS', 'BAR_SECONDS', 'BAR_POOL']),
    minimap: x('src/ui/hud/minimap.ts', ['CELL_PIXELS', 'INK', 'EDGE', 'WALL', 'FLOOR', 'CONE', 'PARTNER', 'DOT', 'TICK', 'INSET', 'RIPPLE_SECONDS', 'RIPPLE_GROWTH']),
    minimapModel: { ...MINIMAP },
    perf: x('src/ui/hud/perf.ts', ['REFRESH_MS']),
    chat: x('src/ui/hud/chat.ts', ['OPEN_KEY', 'MAX_LINES', 'LINE_SECONDS']),
    picker: x('src/ui/hud/picker.ts', ['GOOD_AT']),
    reservedNote: RESERVED_NOTE,
  };
}

/** Every manifest, in file-name order (as tests/ui/credits-model.test.ts and scripts/credits.mjs read them). */
function manifest(): CreditAsset[] {
  const files = import.meta.glob<{ assets: CreditAsset[] }>('../../../assets/*.json', { eager: true, import: 'default' });
  return Object.keys(files)
    .sort()
    .flatMap((path) => files[path]?.assets ?? [])
    .map(({ id, kind, license, source, credit }) => (credit === undefined ? { id, kind, license, source } : { id, kind, license, source, credit }));
}

const asset = (patch: Partial<CreditAsset>): CreditAsset => ({ id: 'x', kind: 'model', license: 'CC0', source: 'https://polyhaven.com/a/thing', ...patch });

/** The inputs of the unit cases in tests/ui/credits-model.test.ts, with the web's answers. */
function creditCases(): unknown[] {
  const credit = '"Steps" by Someone, https://freesound.org/s/9/, CC-BY 4.0';
  const inputs: CreditAsset[][] = [
    [],
    [
      asset({ id: 'a', kind: 'model' }),
      asset({ id: 'b', kind: 'sound', source: 'https://freesound.org/s/1/' }),
      asset({ id: 'c', kind: 'pbr' }),
      asset({ id: 'd', kind: 'hdri' }),
      asset({ id: 'e', kind: 'texture' }),
    ],
    [
      asset({ id: 's1', kind: 'sound', license: 'CC-BY 4.0', source: 'https://freesound.org/s/9/', credit }),
      asset({ id: 's2', kind: 'sound', license: 'CC-BY 4.0', source: 'https://freesound.org/s/9/', credit }),
    ],
    [asset({ id: 'mdl-x', license: 'CC-BY 4.0', source: 'https://example.org/x' })],
    [
      asset({ id: 's1', kind: 'sound', source: 'https://freesound.org/s/1/' }),
      asset({ id: 's2', kind: 'sound', source: 'https://freesound.org/s/1/' }),
      asset({ id: 's3', kind: 'sound', source: 'https://freesound.org/s/2/' }),
      asset({ id: 's4', kind: 'sound', source: 'scripts/process-audio.mjs' }),
    ],
    [asset({ source: 'https://example.org/a/b' })],
    [asset({ source: 'https://www.polyhaven.com:8080/a/b' }), asset({ id: 'y', source: 'not a url' }), asset({ id: 'z', kind: 'sound', source: 'https://opengameart.org/content/the-free-firearm-sound-library' })],
  ];
  return inputs.map((input) => ({ input, groups: buildCredits(input), markdown: creditsMarkdown(buildCredits(input)) }));
}

function feedCases(): unknown[] {
  const random = lcg(99);
  const names = ['You', 'Bot 3', 'Ada', 'Bot 11'];
  const cases = [];
  for (let n = 0; n < 40; n++) {
    const count = Math.floor(random() * 9);
    const entries: KillFeedEntry[] = Array.from({ length: count }, (_, i) => ({
      killer: names[Math.floor(random() * names.length)]!,
      victim: names[Math.floor(random() * names.length)]!,
      weapon: Object.keys(WEAPON_DEFS)[Math.floor(random() * 6)]!,
      headshot: random() < 0.3,
      time: Math.round((i * 1.7 + random() * 3) * 1000) / 1000 + random() * 1e-4,
    }));
    const now = Math.round(random() * 20 * 100) / 100;
    const maxRows = Math.floor(random() * 6) - 1;
    cases.push({ entries, now, maxAge: 6, maxRows, kept: trimKillFeed(entries, now, 6, maxRows).map(feedKey), keys: entries.map(feedKey) });
  }
  return cases;
}

function layoutCases(): unknown[] {
  const random = lcg(4242);
  const cases = [];
  for (let n = 0; n < 30; n++) {
    const nx = 1 + Math.floor(random() * 14);
    const nz = 1 + Math.floor(random() * 14);
    const colStart: number[] = [];
    const edges: number[] = [];
    for (let col = 0; col < nx * nz; col++) {
      colStart.push(edges.length);
      const levels = random() < 0.45 ? 0 : 1 + Math.floor(random() * 3);
      for (let l = 0; l < levels; l++) edges.push(random() < 0.2 ? 0 : 1 + Math.floor(random() * 255));
    }
    colStart.push(edges.length);
    const rim = n % 3 === 0 ? 1 : n % 3 === 1 ? 2 : 3;
    const source: NavSource = { nx, nz, originX: -3 + n, originZ: 12 - n, cell: 0.6, colStart, edges };
    cases.push({ nx, nz, colStart, edges, rim, cells: [...buildLayout(source, rim).cells] });
  }
  return cases;
}

function minimapCases(): unknown {
  const random = lcg(7);
  const point: MapPoint = { x: 0, y: 0, outside: false };
  const toMapCases = Array.from({ length: 200 }, () => {
    const dx = (random() - 0.5) * 140;
    const dz = (random() - 0.5) * 140;
    const yaw = (random() - 0.5) * 14;
    const scale = 0.5 + random() * 3;
    const limit = 30 + random() * 80;
    toMap(point, dx, dz, yaw, scale, limit);
    return { dx, dz, yaw, scale, limit, x: point.x, y: point.y, outside: point.outside };
  });
  const fov = [[75, 16 / 9], [60, 1], [100, 2.4], [90, 0.75]].map(([degrees, aspect]) => ({ degrees, aspect, half: horizontalHalfFov(degrees!, aspect!) }));
  const shots = [[undefined, 3], [2, 3], [5, 3], [0, 0], [1.25, 7.5]].map(([firedAt, now]) => ({ firedAt: firedAt ?? null, now, age: shotAge(firedAt, now!) }));
  const reveals = Array.from({ length: 200 }, (_, i) => {
    const now = i * 0.37;
    const age = revealAge(now);
    return { now, age: Number.isFinite(age) ? age : null };
  });
  return { toMap: toMapCases, fov, shots, reveals, nanReveal: Number.isFinite(revealAge(Number.NaN)) ? 'finite' : 'infinite' };
}

/** The layout raster for one map: "IVL1", u32 nx, u32 nz, u32 0, f64 originX, f64 originZ, f64 cell, then nx * nz cell bytes (row by row along +Z). */
function layoutFile(mapId: string): { bytes: Uint8Array; summary: unknown } {
  const meta = JSON.parse(readFileSync(`${REPO}native/MapPackages/${mapId}/meta.json`, 'utf8')) as {
    bounds: { min: number[]; max: number[] };
    spawns: { player: { position: number[] }[]; enemy: { position: number[] }[] };
  };
  const world = mapWorld(REPO, mapId);
  const bounds = new Box3(new Vector3(...meta.bounds.min), new Vector3(...meta.bounds.max));
  // The order BotManager seeds the grid in (src/ai/manager.ts): enemy spawns, then player spawns.
  const seeds = [...meta.spawns.enemy, ...meta.spawns.player].map((spawn) => new Vector3(...spawn.position));
  const builder = buildNavGrid(world, bounds, seeds);
  let step = builder.next();
  while (!step.done) step = builder.next();
  const layout = buildLayout(step.value);
  const header = new ArrayBuffer(40);
  const view = new DataView(header);
  [0x49, 0x56, 0x4c, 0x31].forEach((byte, i) => view.setUint8(i, byte));
  view.setUint32(4, layout.nx, true);
  view.setUint32(8, layout.nz, true);
  view.setUint32(12, 0, true);
  view.setFloat64(16, layout.originX, true);
  view.setFloat64(24, layout.originZ, true);
  view.setFloat64(32, layout.cell, true);
  const bytes = new Uint8Array(40 + layout.cells.length);
  bytes.set(new Uint8Array(header), 0);
  bytes.set(layout.cells, 40);
  const counts = [0, 0, 0];
  for (const cell of layout.cells) counts[cell]! += 1;
  return { bytes, summary: { map: mapId, nx: layout.nx, nz: layout.nz, originX: layout.originX, originZ: layout.originZ, cell: layout.cell, counts } };
}

it('writes the native HUD fixtures, data and minimap layouts', { timeout: 600_000 }, () => {
  const constants = hudConstants();
  const credits = manifest();
  // The shipped manifests must still give CREDITS.md, as the web test asserts; the native port is checked against both.
  expect(creditsMarkdown(buildCredits(credits))).toBe(creditsFile);

  const random = lcg(31);
  const layouts = LAYOUT_MAPS.map(layoutFile);
  for (const [index, mapId] of LAYOUT_MAPS.entries()) emit(`${LAYOUT_DIR}minimap-${mapId}.bin`, layouts[index]!.bytes);

  const fixtures = {
    source: 'native/Tools/ui-fixtures/hud-fixtures.test.ts',
    damageAngle: Array.from({ length: 300 }, (_, i) => {
      const dx = i % 17 === 0 ? 0 : (random() - 0.5) * 20;
      const dz = i % 17 === 0 ? 0 : (random() - 0.5) * 20;
      const yaw = (random() - 0.5) * 20;
      return { dx, dz, yaw, angle: damageAngle(dx, dz, yaw) };
    }),
    unwrapAngle: Array.from({ length: 200 }, () => {
      const previous = (random() - 0.5) * 40;
      const target = (random() - 0.5) * 40;
      return { previous, target, angle: unwrapAngle(previous, target) };
    }),
    healthEffects: Array.from({ length: 57 }, (_, i) => {
      const health = -20 + i * 2.5;
      return { health, ...healthEffects(health) };
    }),
    feed: feedCases(),
    respawnCountdown: [[0, 0, 3], [1, 2.2, 3], [1, 3.99, 3], [1, 4.01, 3], [10, 12.5, 3], [0, 0.0001, 3], [5, 4, 3], [0, 0, 0]].map(([diedAt, now, delay]) => ({
      diedAt,
      now,
      delay,
      seconds: respawnCountdown(diedAt!, now!, delay!),
    })),
    rulesOf: [null, { mode: 'skirmish' }, { mode: 'survival' }, { mode: 'duel' }, { mode: 'coop' }, { mode: 'coop', rules: 'survival' }, { mode: 'coop', rules: 'skirmish' }].map((config) => ({
      config,
      rules: rulesOf(config as Parameters<typeof rulesOf>[0]),
    })),
    killNote: [false, true].flatMap((headshot) =>
      [0, 1, 2, 3, 4, 5, 6, 9, 12].flatMap((streak) => [0, 20, 59.4, 59.6, 60, 84.4, 84.5, 312.7].map((distance) => ({ headshot, streak, distance, text: killNote(headshot, streak, distance) }))),
    ),
    grenadeHint: [0, 1, 2].flatMap((count) => [false, true].flatMap((aiming) => ['G', 'Q', 'Middle click'].map((key) => ({ count, aiming, key, text: grenadeHint(count, aiming, key) })))),
    grenadeKey: Object.fromEntries((['trackpad', 'mouse'] as const).map((preset) => [preset, keyName(BINDING_PRESETS[preset].grenade[0] ?? '', preset)])),
    layouts: layoutCases(),
    mapLayouts: layouts.map((layout) => layout.summary),
    minimap: minimapCases(),
    weaponStats: Object.values(WEAPON_DEFS).map((def) => ({ id: def.id, stats: weaponStats(def) })),
    credits: creditCases(),
    creditsMarkdown: creditsFile,
    names: ['Ada', '  Ada  Lovelace  ', '', 42, null, 'a'.repeat(30), 'Zoë 🎯 <b>', '\u0000x\u0007y', '名前テスト', 'éclair'].map((raw) => ({
      raw,
      stored: JSON.stringify({ name: sanitizeName(raw) }),
      read: sanitizeName(raw),
    })),
  };
  emit(FIXTURES, `${JSON.stringify(fixtures, null, 2)}\n`);

  const data = { constants, creditAssets: credits };
  const json = JSON.stringify(data);
  expect(json.includes('"##')).toBe(false);
  const swift = [
    '// Generated by native/Tools/ui-fixtures/hud-fixtures.test.ts from src/ (ui/hud/*.ts module constants through',
    '// contract-export\'s parser, ui/hud/minimap-model.ts, weapons/loadout.ts, assets/*.json). Do not edit.',
    '// Regenerate: npx vitest run --config native/Tools/vitest.config.ts native/Tools/ui-fixtures/hud-fixtures.test.ts',
    '',
    'enum WebHUDData {',
    `    static let json = ##"${json}"##`,
    '}',
    '',
  ].join('\n');
  emit(SWIFT, swift);
  expect(drift, 'outputs out of date with src/ (run without HUD_FIXTURES_CHECK to regenerate)').toEqual([]);
});
