/**
 * nav-fixtures (M7b, PLAN.md 7): runs the web's buildNavGrid (src/ai/navgrid.ts) on each exported map
 * package, through the real TS CollisionWorld rebuilt from collision.bin / boundary.bin, with the seeds
 * BotManager.enterMap uses (enemy spawns, then player spawns), and writes native/Contract/nav/<map>.json:
 * the grid size, node count, per-array SHA-256 and the full edge and edge-layer arrays (base64), so the
 * Swift NavGrid build must match node for node.
 * With NAV_FIXTURES_CHECK=1 it regenerates in memory and fails on any difference. Run ./run.sh [--check].
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Box3, Vector3 } from 'three/webgpu';
import { expect, it } from 'vitest';
import { buildNavGrid, type NavGrid } from '../../../src/ai/navgrid';
import { mapWorld } from '../sim-fixtures/worlds';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const outDir = resolve(repoRoot, 'native/Contract/nav');
const check = process.env.NAV_FIXTURES_CHECK === '1';
const MAPS = ['range', 'railyard', 'headworks', 'harbor'];

interface Meta {
  bounds: { min: number[]; max: number[] };
  spawns: { player: { position: number[] }[]; enemy: { position: number[] }[] };
}

const bytes = (array: ArrayBufferView): Buffer => Buffer.from(array.buffer, array.byteOffset, array.byteLength);
const sha = (array: ArrayBufferView): string => createHash('sha256').update(bytes(array)).digest('hex');

function describe(grid: NavGrid): Record<string, unknown> {
  // Little-endian on every supported host; the Swift side hashes the same layouts.
  return {
    nx: grid.nx,
    nz: grid.nz,
    originX: grid.originX,
    originZ: grid.originZ,
    nodeCount: grid.nodeCount,
    linkedNodes: grid.edges.reduce((n, mask) => n + (mask ? 1 : 0), 0),
    sha256: {
      colStart: sha(grid.colStart),
      nodeY: sha(grid.nodeY),
      edges: sha(grid.edges),
      edgeLayers: sha(grid.edgeLayers),
      coverLow: sha(grid.coverLow),
      coverHigh: sha(grid.coverHigh),
      wet: sha(grid.wet),
    },
    edges: bytes(grid.edges).toString('base64'),
    edgeLayers: bytes(grid.edgeLayers).toString('base64'),
  };
}

it('exports the nav-grid fixtures', () => {
  const outputs: Record<string, string> = {};
  for (const mapId of MAPS) {
    const meta = JSON.parse(readFileSync(resolve(repoRoot, 'native/MapPackages', mapId, 'meta.json'), 'utf8')) as Meta;
    const world = mapWorld(repoRoot, mapId);
    const bounds = new Box3(new Vector3(...meta.bounds.min), new Vector3(...meta.bounds.max));
    const seeds = [...meta.spawns.enemy, ...meta.spawns.player].map((s) => new Vector3(...s.position));
    const builder = buildNavGrid(world, bounds, seeds);
    let step = builder.next();
    while (!step.done) step = builder.next();
    outputs[`${mapId}.json`] = `${JSON.stringify({ map: mapId, ...describe(step.value) }, null, 1)}\n`;
  }
  if (check) {
    const stale = Object.entries(outputs).filter(([name, text]) => {
      const path = resolve(outDir, name);
      return !existsSync(path) || readFileSync(path, 'utf8') !== text;
    });
    expect(stale.map(([name]) => name), 'native/Contract/nav is out of date; run native/Tools/nav-fixtures/run.sh').toEqual([]);
    return;
  }
  mkdirSync(outDir, { recursive: true });
  for (const [name, text] of Object.entries(outputs)) writeFileSync(resolve(outDir, name), text);
}, 600_000);
