/**
 * Reads top-level `const` declarations out of a TypeScript source file with Vite's parser (oxc,
 * ESTree output), for constants the web code does not export. Only literal data is evaluated:
 * numbers, strings, booleans, regex sources, arrays, objects, unary minus, + - * /, `Math.PI`
 * and references to other constants in the same file. Anything else throws, so a refactor in
 * `src/` that changes a constant's shape fails the export loudly instead of giving a wrong value.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSync } from 'vite';

export type ConstValue = number | string | boolean | ConstValue[] | { [key: string]: ConstValue };

// The ESTree node shapes used here; the parser's own types are not part of Vite's public surface.
interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

interface Parsed {
  readonly decls: Map<string, Node>;
  readonly file: string;
  readonly text: string;
}

const cache = new Map<string, Parsed>();

function parse(repoRoot: string, relative: string): Parsed {
  const cached = cache.get(relative);
  if (cached) return cached;
  const text = readFileSync(resolve(repoRoot, relative), 'utf8');
  const result = parseSync(relative, text) as unknown as { program: { body: Node[] }; errors: unknown[] };
  if (result.errors.length > 0) throw new Error(`${relative}: parse errors`);
  const decls = new Map<string, Node>();
  for (let statement of result.program.body) {
    if (statement.type === 'ExportNamedDeclaration' && statement.declaration) statement = statement.declaration as Node;
    if (statement.type !== 'VariableDeclaration') continue;
    for (const decl of statement.declarations as Node[]) {
      const id = decl.id as Node;
      if (id.type === 'Identifier' && decl.init) decls.set(id.name as string, decl.init as Node);
    }
  }
  const parsed = { decls, file: relative, text };
  cache.set(relative, parsed);
  return parsed;
}

function unwrap(node: Node): Node {
  let current = node;
  while (['TSAsExpression', 'TSSatisfiesExpression', 'ParenthesizedExpression', 'TSNonNullExpression'].includes(current.type)) {
    current = current.expression as Node;
  }
  return current;
}

function evaluate(parsed: Parsed, node: Node, seen: Set<string>): ConstValue {
  const expr = unwrap(node);
  const fail = (): never => {
    throw new Error(`${parsed.file}: cannot evaluate \`${parsed.text.slice(expr.start, expr.end)}\` as constant data`);
  };
  switch (expr.type) {
    case 'Literal': {
      if (expr.regex) return (expr.regex as { pattern: string }).pattern;
      const value = expr.value;
      return typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean' ? value : fail();
    }
    case 'TemplateLiteral': {
      const quasis = expr.quasis as Node[];
      return (expr.expressions as Node[]).length === 0 ? ((quasis[0]!.value as { cooked: string }).cooked) : fail();
    }
    case 'UnaryExpression': {
      const value = evaluate(parsed, expr.argument as Node, seen);
      return expr.operator === '-' && typeof value === 'number' ? -value : fail();
    }
    case 'BinaryExpression': {
      const left = evaluate(parsed, expr.left as Node, seen);
      const right = evaluate(parsed, expr.right as Node, seen);
      if (typeof left !== 'number' || typeof right !== 'number') return fail();
      if (expr.operator === '+') return left + right;
      if (expr.operator === '-') return left - right;
      if (expr.operator === '*') return left * right;
      if (expr.operator === '/') return left / right;
      return fail();
    }
    case 'MemberExpression':
      return parsed.text.slice(expr.start, expr.end) === 'Math.PI' ? Math.PI : fail();
    case 'Identifier':
      return constant(parsed, expr.name as string, seen);
    case 'ArrayExpression':
      return (expr.elements as (Node | null)[]).map((element) => (element ? evaluate(parsed, element, seen) : fail()));
    case 'ObjectExpression': {
      const out: { [key: string]: ConstValue } = {};
      for (const property of expr.properties as Node[]) {
        if (property.type !== 'Property' || property.computed || property.kind !== 'init') return fail();
        out[keyName(property.key as Node) ?? fail()] = evaluate(parsed, property.value as Node, seen);
      }
      return out;
    }
    default:
      return fail();
  }
}

function keyName(key: Node): string | null {
  if (key.type === 'Identifier') return key.name as string;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

function constant(parsed: Parsed, name: string, seen: Set<string>): ConstValue {
  const initializer = parsed.decls.get(name);
  if (!initializer) throw new Error(`${parsed.file}: no top-level const named ${name}`);
  if (seen.has(name)) throw new Error(`${parsed.file}: ${name} refers to itself`);
  return evaluate(parsed, initializer, new Set([...seen, name]));
}

/** The values of the named top-level constants in `relative` (a path from the repository root). */
export function extractConsts(repoRoot: string, relative: string, names: readonly string[]): Record<string, ConstValue> {
  const parsed = parse(repoRoot, relative);
  return Object.fromEntries(names.map((name) => [name, constant(parsed, name, new Set())]));
}

/** The property names of a top-level object literal, in source order (for objects of functions). */
export function extractKeys(repoRoot: string, relative: string, name: string): string[] {
  const parsed = parse(repoRoot, relative);
  const initializer = parsed.decls.get(name);
  if (!initializer) throw new Error(`${relative}: no top-level const named ${name}`);
  const expr = unwrap(initializer);
  if (expr.type !== 'ObjectExpression') throw new Error(`${relative}: ${name} is not an object literal`);
  return (expr.properties as Node[]).map((property) => {
    const key = property.type === 'Property' && !property.computed ? keyName(property.key as Node) : null;
    if (key === null) throw new Error(`${relative}: ${name} has a computed or spread key`);
    return key;
  });
}
