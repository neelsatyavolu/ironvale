// Golden fixtures for the duel rules (M6), computed by the web's own src/net/rules.ts: pickDuelSpawn
// over each map's real spawn list (the duel draws from player + enemy spawns, as session.ts does)
// against a grid of opponent positions, duelResult, duelBotSide and duelBotsHere.
// Writes fixtures/duel-rules.json; with NET_FIXTURES_CHECK=1 it fails if the file is stale.
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { duelBotSide, duelBotsHere, duelResult, pickDuelSpawn } from '../../../src/net/rules';

const OUT = new URL('./fixtures/duel-rules.json', import.meta.url).pathname;
const PACKAGES = new URL('../../MapPackages/', import.meta.url).pathname;
const MAPS = ['range', 'railyard', 'headworks', 'harbor'];

interface Spawn {
  readonly position: [number, number, number];
}

function build() {
  const spawns = MAPS.map((id) => {
    const meta = JSON.parse(readFileSync(`${PACKAGES}${id}/meta.json`, 'utf8')) as { spawns: { player: Spawn[]; enemy: Spawn[] } };
    const points = [...meta.spawns.player, ...meta.spawns.enemy].map((s) => ({ x: s.position[0], z: s.position[2] }));
    const cases: { opponent: [number, number]; index: number }[] = [];
    // The spawns themselves (ties and zero distances included) and a 9 x 9 grid over the map.
    for (const p of points) cases.push({ opponent: [p.x, p.z], index: pickDuelSpawn(points, p) });
    for (let i = -4; i <= 4; i++) {
      for (let j = -4; j <= 4; j++) {
        const opponent = { x: i * 15.5, z: j * 15.5 };
        cases.push({ opponent: [opponent.x, opponent.z], index: pickDuelSpawn(points, opponent) });
      }
    }
    return { map: id, spawns: points.map((p) => [p.x, p.z]), cases };
  });
  const ties = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }];
  const results: { kills: number; deaths: number; target: number; result: string | null }[] = [];
  for (const target of [1, 3, 10]) {
    for (let kills = 0; kills <= 11; kills++) {
      for (let deaths = 0; deaths <= 11; deaths++) results.push({ kills, deaths, target, result: duelResult(kills, deaths, target) });
    }
  }
  const sides = (['host', 'guest'] as const).flatMap((owner) =>
    (['host', 'guest'] as const).map((role) => ({ owner, role, ...duelBotSide(owner, role) })),
  );
  const here = (['none', 'host', 'guest'] as const).flatMap((duelBot) =>
    (['host', 'guest'] as const).map((role) => ({ duelBot, role, count: duelBotsHere(duelBot, role) })),
  );
  return {
    spawns,
    ties: { spawns: ties.map((p) => [p.x, p.z]), index: pickDuelSpawn(ties, { x: 0, z: 0 }), empty: pickDuelSpawn([], { x: 0, z: 0 }) },
    results,
    sides,
    here,
  };
}

test('duel-rules fixtures', () => {
  const text = `${JSON.stringify(build(), null, 2)}\n`;
  if (process.env.NET_FIXTURES_CHECK === '1') {
    expect(readFileSync(OUT, 'utf8'), 'native/Tools/interop/fixtures/duel-rules.json is stale: rerun duel-fixtures').toBe(text);
  } else {
    writeFileSync(OUT, text);
  }
});
