/**
 * sim-fixtures (PLAN.md 5.4 layer 1, M4): writes native/Contract/sim/ from the web sources.
 *   sim.json         constants IronvaleSim reads at run time (constants.ts)
 *   worlds.json      the TS test worlds as triangle soups
 *   player-*.json    PlayerController scripted-input traces on the box world and each map
 *   weapons.json     WeaponMachine traces, grenade trajectories, damage and blast curves
 *   fallback-guns.json  the stand-in gun shapes (src/weapons/view/fallback.ts) for IronvaleViewModel
 * With SIM_FIXTURES_CHECK=1 it regenerates in memory and fails on any difference. Run ./run.sh [--check].
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { simConstants } from './constants';
import { fallbackGuns } from './fallback';
import { makeScript, runScript } from './player';
import { blastCurve, damageGrid, grenadeTraces, machineTraces } from './weapons';
import { BOX_INTERIOR, boxWorld, exportWorld, grenadeMathWorld, grenadesWorld, mapWorld } from './worlds';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const outDir = resolve(repoRoot, 'native/Contract/sim');
const check = process.env.SIM_FIXTURES_CHECK === '1';
const MAPS = ['range', 'railyard', 'headworks', 'harbor'];
const FRAMES = 360;

/** Keys sorted at every level; arrays of numbers on one line so the files stay readable in diffs. */
function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort((item as Record<string, unknown>)[key])]));
    }
    return item;
  };
  const text = JSON.stringify(sort(value), null, 1);
  // Collapse innermost arrays (no nested brackets) onto one line.
  return `${text.replace(/\[[^[\]{}]*\]/g, (match) => match.replace(/\s+/g, ''))}\n`;
}

it('exports the sim fixtures', () => {
  const outputs: Record<string, string> = {};
  outputs['sim.json'] = canonical(simConstants(repoRoot));
  outputs['fallback-guns.json'] = canonical(fallbackGuns());

  const box = boxWorld();
  outputs['worlds.json'] = canonical({
    box: { ...exportWorld(box), interiors: [BOX_INTERIOR] },
    grenadeMath: exportWorld(grenadeMathWorld()),
    grenades: exportWorld(grenadesWorld()),
  });

  const boxScripts = [
    makeScript('box:0', { position: [0, 0, 0], yaw: 0 }, FRAMES, 'mouse'),
    makeScript('box:1', { position: [-6, 0, 2], yaw: 0.3 }, FRAMES, 'mouse'),
    makeScript('box:2', { position: [0.5, 0, 10], yaw: 0 }, FRAMES, 'trackpad'),
    makeScript('box:3', { position: [12, 0, 10], yaw: 0 }, FRAMES, 'mouse'),
    makeScript('box:4', { position: [4, 0, 0], yaw: -1.2 }, FRAMES, 'trackpad'),
  ];
  outputs['player-box.json'] = canonical({ world: 'box', traces: boxScripts.map((s) => runScript(box, [BOX_INTERIOR], s)) });

  for (const mapId of MAPS) {
    const metaPath = resolve(repoRoot, 'native/MapPackages', mapId, 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
      spawns: { player: { position: number[]; yaw: number }[] };
      interiors: { min: number[]; max: number[] }[];
    };
    const world = mapWorld(repoRoot, mapId);
    const spawns = meta.spawns.player;
    const scripts = [0, 1, 2].map((i) =>
      makeScript(`${mapId}:${i}`, spawns[i % spawns.length]!, FRAMES, i === 2 ? 'trackpad' : 'mouse'),
    );
    outputs[`player-${mapId}.json`] = canonical({
      world: mapId,
      traces: scripts.map((s) => runScript(world, meta.interiors, s)),
    });
  }

  outputs['weapons.json'] = canonical({
    machine: machineTraces(),
    grenade: grenadeTraces(grenadeMathWorld()),
    damage: damageGrid(),
    blast: blastCurve(),
  });

  if (check) {
    const stale = Object.entries(outputs)
      .filter(([name, text]) => {
        const path = resolve(outDir, name);
        return !existsSync(path) || readFileSync(path, 'utf8') !== text;
      })
      .map(([name]) => name);
    expect(stale, 'native/Contract/sim is out of date; run native/Tools/sim-fixtures/run.sh').toEqual([]);
    return;
  }
  mkdirSync(outDir, { recursive: true });
  for (const [name, text] of Object.entries(outputs)) writeFileSync(resolve(outDir, name), text);
});
