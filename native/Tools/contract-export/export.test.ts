/**
 * contract-export (PLAN.md 5.2, 5.3). Runs under Vitest so the web modules resolve as they do
 * in `tests/`. Writes native/Contract/*.json, fixtures and contract.lock; with
 * CONTRACT_EXPORT_CHECK=1 it regenerates in memory and fails on any difference from what is
 * committed. Run it through ./run.sh [--check].
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { binaryFixtures, coreFixtures, eventFixtures, inviteFixtures, limitFixtures, roomFixtures } from './fixtures';
import { aiTable, bodiesTable, mapsTable, protocolTable, weaponsTable } from './tables';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const contractDir = resolve(repoRoot, 'native/Contract');
const check = process.env.CONTRACT_EXPORT_CHECK === '1';

/** Keys sorted at every level, two-space indent, trailing newline. */
function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort((item as Record<string, unknown>)[key])]));
    }
    return item;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** Fixture files: one case per line so a diff names the case that changed. */
function fixtureText(value: Record<string, unknown>): string {
  const lines: string[] = [];
  const keys = Object.keys(value).sort();
  keys.forEach((key, index) => {
    const item = value[key];
    const comma = index < keys.length - 1 ? ',' : '';
    if (Array.isArray(item)) {
      lines.push(`  ${JSON.stringify(key)}: [`);
      item.forEach((entry, i) => lines.push(`    ${JSON.stringify(entry)}${i < item.length - 1 ? ',' : ''}`));
      lines.push(`  ]${comma}`);
    } else if (item && typeof item === 'object') {
      lines.push(`  ${JSON.stringify(key)}: ${fixtureText(item as Record<string, unknown>).trimEnd().replace(/\n/g, '\n  ')}${comma}`);
    } else {
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(item)}${comma}`);
    }
  });
  return `{\n${lines.join('\n')}\n}\n`;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

it('exports the contract', async () => {
  const tables: Record<string, string> = {
    'protocol.json': canonical(protocolTable(repoRoot)),
    'weapons.json': canonical(weaponsTable()),
    'bodies.json': canonical(bodiesTable(repoRoot)),
    'ai.json': canonical(aiTable()),
    'maps.json': canonical(mapsTable(repoRoot)),
  };
  const fixtures: Record<string, string> = {
    'fixtures/core.json': fixtureText(coreFixtures() as Record<string, unknown>),
    'fixtures/binary.json': fixtureText(binaryFixtures() as Record<string, unknown>),
    'fixtures/events.json': fixtureText(eventFixtures() as Record<string, unknown>),
    'fixtures/limits.json': fixtureText(limitFixtures() as Record<string, unknown>),
    'fixtures/room.json': fixtureText(roomFixtures() as Record<string, unknown>),
    'fixtures/invite.json': fixtureText((await inviteFixtures()) as Record<string, unknown>),
  };
  const protocolVersion = (JSON.parse(tables['protocol.json']!) as { protocolVersion: number }).protocolVersion;
  const contractHash = sha256(['protocol.json', 'weapons.json', 'bodies.json', 'ai.json'].map((name) => tables[name]).join(''));

  const lockPath = resolve(contractDir, 'contract.lock');
  const previous = existsSync(lockPath) ? (JSON.parse(readFileSync(lockPath, 'utf8')) as { protocolVersion: number; contractHash: string }) : null;
  if (previous && previous.contractHash !== contractHash && previous.protocolVersion === protocolVersion && process.env.CONTRACT_ACCEPT_SAME_VERSION !== '1') {
    throw new Error(
      `The cross-play contract changed (hash ${previous.contractHash.slice(0, 12)} -> ${contractHash.slice(0, 12)}) but PROTOCOL_VERSION is still ${protocolVersion}. ` +
        'Bump PROTOCOL_VERSION in src/net/wire.ts (PLAN.md 5.3), or set CONTRACT_ACCEPT_SAME_VERSION=1 if the change is provably compatible.',
    );
  }
  const outputs = { ...tables, ...fixtures, 'contract.lock': canonical({ protocolVersion, contractHash }) };

  if (check) {
    const stale = Object.entries(outputs).filter(([name, text]) => {
      const path = resolve(contractDir, name);
      return !existsSync(path) || readFileSync(path, 'utf8') !== text;
    });
    expect(stale.map(([name]) => name), 'native/Contract is out of date; run native/Tools/contract-export/run.sh').toEqual([]);
    return;
  }
  for (const [name, text] of Object.entries(outputs)) {
    const path = resolve(contractDir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
});
