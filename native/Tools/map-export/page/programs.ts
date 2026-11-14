// Surface-program labels for the native renderer (PLAN.md 3.4, M3b). TSL node graphs cannot be
// exported, so each map material is matched to the web factory that made it and tagged with that
// factory's name ("program"); the native side runs the hand-ported MSL for that name.
//
// Matching: the map's material factories are run a second time on a scratch Kit, and every
// material gets a structural fingerprint (material scalars, texture slots, and the node graph's
// node types, operators and constants). A live material whose fingerprint equals a reference's
// gets the reference's name. Fingerprints are compared, never guessed, so a web change that
// alters a program shows up as an unlabelled material instead of a silently wrong one.
//
// Also captured here: per-instance attributes that a colour node reads (the container livery),
// and the plan numbers the Railyard programs read (lamp glows, shed and office boxes, the sun in
// the sky texture), so the MSL does not hand-copy them.
import * as THREE from 'three/webgpu';
import { instancedBufferAttribute } from 'three/tsl';
import type { MapBuildContext } from '../../../../src/game/contracts';
import { RTG, STS } from '../../../../src/maps/railyard/cranes';
import { Kit } from '../../../../src/maps/railyard/kit';
import { POLE_HEIGHT, POLES, WALL_LAMPS, WARM } from '../../../../src/maps/railyard/lamps';
import { LIGHTING, SUN_IN_SKY } from '../../../../src/maps/railyard/lighting';
import { createMaterials } from '../../../../src/maps/railyard/materials';
import { OFFICE, WAREHOUSE } from '../../../../src/maps/railyard/plan';
import { shelter } from '../../../../src/maps/railyard/shelter';
import { buildSky } from '../../../../src/maps/railyard/sky';
import { harborPrograms } from './programs-harbor';
import { headworksPrograms } from './programs-headworks';
import { rangePrograms } from './programs-range';

const NODE_SLOTS = ['colorNode', 'roughnessNode', 'metalnessNode', 'opacityNode', 'normalNode', 'vertexNode', 'positionNode'] as const;
const SCALARS = ['type', 'transparent', 'alphaTest', 'side', 'vertexColors', 'depthWrite', 'fog', 'roughness', 'metalness', 'opacity'] as const;
const MAP_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap'] as const;

type AnyNode = Record<string, unknown> & { isNode?: boolean };

/** Structural description of one node graph; memoised per node so shared sub-graphs stay linear. */
export function graphKey(node: unknown, memo: Map<unknown, string>, stack: Set<unknown>, maskConstants = false): string {
  if (typeof node === 'number' || typeof node === 'boolean' || typeof node === 'string') return JSON.stringify(node);
  if (!node || typeof node !== 'object') return '_';
  const known = memo.get(node);
  if (known !== undefined) return known;
  if (stack.has(node)) return '^';
  const n = node as AnyNode;
  if (Array.isArray(node)) return `[${node.map((c) => graphKey(c, memo, stack, maskConstants)).join(',')}]`;
  if (n.isNode !== true) return '_';
  stack.add(node);
  const parts: string[] = [String((n.constructor as { type?: string }).type ?? n.constructor.name)];
  const isConst = (n as { isConstNode?: boolean }).isConstNode === true;
  for (const key of ['op', 'method', 'components', 'name', 'scope', 'nodeType']) {
    // A masked constant keeps no type: TSL types a whole number as int and a fraction as float.
    if (maskConstants && isConst && key === 'nodeType') continue;
    if (typeof n[key] === 'string') parts.push(`${key}=${n[key] as string}`);
  }
  if ((n as { isConstNode?: boolean }).isConstNode) parts.push(maskConstants ? 'v=#' : `v=${constValue(n.value)}`);
  for (const key of Object.keys(n).sort()) {
    if (key === 'value' || key.startsWith('_') || key === 'parents' || key === 'uuid') continue;
    const child = n[key];
    if ((child as AnyNode)?.isNode || (Array.isArray(child) && child.some((c) => (c as AnyNode)?.isNode))) {
      parts.push(`${key}:${graphKey(child, memo, stack, maskConstants)}`);
    }
  }
  stack.delete(node);
  const key = `(${parts.join(' ')})`;
  memo.set(node, key);
  return key;
}

function constValue(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof THREE.Color) return `c${value.r},${value.g},${value.b}`;
  if (value && typeof value === 'object' && 'toArray' in value) return `a${(value as { toArray(): number[] }).toArray().join(',')}`;
  return '?';
}

/**
 * Structural fingerprint of a material. `family` masks every node constant and the colour and
 * roughness scalars, so all materials one parameterised factory makes share it (programs-harbor.ts);
 * `skipEmissive` leaves out an emission node added after the factory (Harbor's shadeLit).
 */
export function fingerprint(material: THREE.Material, family = false, skipEmissive = false): string {
  const any = material as unknown as Record<string, unknown>;
  const memo = new Map<unknown, string>();
  const parts: string[] = [];
  for (const key of SCALARS) parts.push(`${key}=${family && key === 'roughness' ? '#' : String(any[key])}`);
  const color = any.color instanceof THREE.Color ? (any.color as THREE.Color).getHex() : -1;
  parts.push(`color=${family ? '#' : color}`);
  for (const slot of MAP_SLOTS) parts.push(`${slot}=${any[slot] ? 1 : 0}`);
  for (const slot of [...NODE_SLOTS, ...(family ? (['emissiveNode'] as const) : [])]) {
    const node = slot === 'emissiveNode' && skipEmissive ? null : any[slot];
    parts.push(`${slot}=${graphKey(node, memo, new Set(), family)}`);
  }
  return parts.join('|');
}

/**
 * Every constant in a material's node slots (and emissiveNode), in the order graphKey walks them,
 * each node once. Materials of one family list their constants in the same order.
 */
export function constantsOf(material: THREE.Material): unknown[] {
  const any = material as unknown as Record<string, unknown>;
  // Per node, the constants of its whole expanded tree: shared sub-graphs (and TSL's shared
  // constant nodes) count at every place they are used, so positions depend on structure only.
  const memo = new Map<unknown, unknown[]>();
  const stack = new Set<unknown>();
  const visit = (node: unknown): unknown[] => {
    if (!node || typeof node !== 'object') return [];
    const known = memo.get(node);
    if (known) return known;
    if (stack.has(node)) return [];
    let out: unknown[] = [];
    if (Array.isArray(node)) {
      stack.add(node);
      for (const c of node) out = out.concat(visit(c));
      stack.delete(node);
    } else {
      const n = node as AnyNode;
      if (n.isNode !== true) return [];
      if ((n as { isConstNode?: boolean }).isConstNode) out.push(n.value);
      stack.add(node);
      for (const key of Object.keys(n).sort()) {
        if (key === 'value' || key.startsWith('_') || key === 'parents' || key === 'uuid') continue;
        out = out.concat(visit(n[key]));
      }
      stack.delete(node);
    }
    memo.set(node, out);
    return out;
  };
  return [...NODE_SLOTS, 'emissiveNode'].flatMap((slot) => visit(any[slot]));
}

/** Every distinct texture a node graph samples. */
export function texturesIn(node: unknown): THREE.Texture[] {
  const seen = new Set<unknown>();
  const out: THREE.Texture[] = [];
  const visit = (n: unknown): void => {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) {
      for (const c of n) visit(c);
      return;
    }
    const a = n as AnyNode;
    if (a.isNode !== true) return;
    if ((a as { isTextureNode?: boolean }).isTextureNode && a.value instanceof THREE.Texture && !out.includes(a.value)) out.push(a.value);
    for (const key of Object.keys(a).sort()) {
      if (key === 'value' || key === 'parents') continue;
      visit(a[key]);
    }
  };
  visit(node);
  return out;
}

/** A per-instance attribute read through `instancedBufferAttribute` inside a material's colour node. */
export function instanceAttributeOf(material: THREE.Material): THREE.InstancedBufferAttribute | null {
  const seen = new Set<unknown>();
  const visit = (node: unknown): THREE.InstancedBufferAttribute | null => {
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    const n = node as AnyNode;
    if (Array.isArray(node)) {
      for (const c of node) {
        const found = visit(c);
        if (found) return found;
      }
      return null;
    }
    if (n.isNode !== true) return null;
    if ((n as { isBufferNode?: boolean }).isBufferNode && (n.value as THREE.InstancedBufferAttribute)?.isInstancedBufferAttribute) {
      return n.value as THREE.InstancedBufferAttribute;
    }
    for (const key of Object.keys(n)) {
      if (key === 'value' || key === 'parents') continue;
      const found = visit(n[key]);
      if (found) return found;
    }
    return null;
  };
  return visit((material as unknown as { colorNode?: unknown }).colorNode);
}

export interface ProgramTable {
  /** Program name per reference fingerprint. */
  readonly byFingerprint: Map<string, string>;
  /** Ambient-occlusion node graphs per name (Railyard: the sky visibility folded in by `shelter`). */
  readonly aoGraphs: Map<string, string>;
  /** Emission node graphs per name (Headworks: the lamp pools of lampLit; Harbor: the bounce of shadeLit). */
  readonly emissiveGraphs?: Map<string, string>;
  /** Railyard's plan numbers, written to scene.json as `programParams` (RailyardProgramParams.swift). */
  readonly params?: Record<string, unknown>;
  /**
   * Other maps' plan numbers as float4 rows, written to scene.json as `programRows` and read by
   * the map's MSL at the row indices its header names (MapSurface.h IV_HW_*, IV_HB_*).
   */
  readonly rows?: number[][];
  /**
   * Program and arguments of a material made by a parameterised factory (Harbor: plaster in seven
   * tints), read from its node constants; checked before `byFingerprint`.
   */
  readonly classify?: (material: THREE.Material) => { program: string; args: number[] } | null;
  /**
   * Map-wide textures the programs sample (Harbor: grime atlas, shade bake, wave slopes), found in
   * the live level (the shade bake only exists there), by name.
   */
  readonly textures?: (root: THREE.Object3D) => Record<string, THREE.Texture>;
}

/**
 * Name every reference material by fingerprint, as "<mapId>.<name>" (Railyard's names predate the
 * prefix and stay bare); two references with one fingerprint are an error.
 */
export function namePrograms(mapId: string, references: readonly (readonly [string, THREE.Material])[]): Map<string, string> {
  const byFingerprint = new Map<string, string>();
  for (const [bare, material] of references) {
    const name = `${mapId}.${bare}`;
    const key = fingerprint(material);
    const clash = byFingerprint.get(key);
    if (clash !== undefined && clash !== name) throw new Error(`${mapId} programs ${clash} and ${name} have the same fingerprint`);
    byFingerprint.set(key, name);
  }
  return byFingerprint;
}

/** A colour as three's `color(hex)` / `new THREE.Color(hex)` gives it: linear, under the default colour management. */
export function linear(hex: number): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

/** Glow list of src/maps/railyard/lamps.ts glows(), which is module-private there. Kept in step by hand. */
function railyardGlows() {
  const list: { at: number[]; color: number; strength: number; reach: number; down?: boolean; facing?: number[] }[] = WALL_LAMPS.map(
    (lamp) => ({
      at: [lamp.x + lamp.nx * 0.5, lamp.y - 0.15, lamp.z + lamp.nz * 0.5],
      color: lamp.color,
      strength: lamp.y > 5 ? 46 : 26,
      reach: lamp.y > 5 ? 13 : 9,
      facing: [lamp.nx, lamp.nz],
    }),
  );
  for (const [x, z, heading] of [POLES[3], POLES[4]] as const) {
    list.push({ at: [x + Math.sin(heading) * 3, POLE_HEIGHT, z + Math.cos(heading) * 3], color: WARM, strength: 150, reach: 30, down: true });
  }
  const sts = (STS.west + STS.east) / 2;
  list.push({ at: [sts, STS.portal - 0.5, STS.landside], color: 0xfff0d2, strength: 110, reach: 24, down: true });
  for (const x of [RTG.west + 5.5, RTG.east - 5.5]) {
    list.push({ at: [x, RTG.girder - 0.4, (RTG.north + RTG.south) / 2], color: 0xfff0d2, strength: 190, reach: 30, down: true });
  }
  // Linear colour, as `new THREE.Color(hex)` gives it under the default colour management.
  return list.map((g) => {
    const c = new THREE.Color(g.color);
    return { ...g, linear: [c.r, c.g, c.b] };
  });
}

function railyardPrograms(ctx: MapBuildContext): ProgramTable {
  const kit = new Kit(ctx);
  const materials = createMaterials(kit);
  buildSky(kit);
  const references: [string, THREE.Material][] = [];
  for (const [name, value] of Object.entries(materials)) {
    if (value instanceof THREE.Material) references.push([name, value]);
  }
  const dummy = instancedBufferAttribute(new THREE.InstancedBufferAttribute(new Float32Array(3), 3));
  references.push(['containerPaint', materials.containerPaint(dummy)]);
  kit.root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !Array.isArray(mesh.material) && mesh.material.side === THREE.BackSide) references.push(['sky', mesh.material]);
  });
  const byFingerprint = new Map<string, string>();
  for (const [name, material] of references) {
    const key = fingerprint(material);
    const clash = byFingerprint.get(key);
    if (clash !== undefined && clash !== name) throw new Error(`railyard programs ${clash} and ${name} have the same fingerprint`);
    byFingerprint.set(key, name);
  }
  if (!references.some(([n]) => n === 'sky')) throw new Error('railyard sky dome not found');
  // shelter() on a material with and without an aoMap gives the two forms of its aoNode.
  const aoGraphs = new Map<string, string>();
  for (const withMap of [false, true]) {
    const probe = new THREE.MeshStandardNodeMaterial();
    if (withMap) probe.aoMap = new THREE.Texture();
    shelter(probe, materials.visibility);
    aoGraphs.set(graphKey(probe.aoNode, new Map(), new Set()), 'skyVisibility');
    probe.dispose();
  }
  kit.dispose();

  const W = WAREHOUSE;
  const params = {
    sunInSky: [SUN_IN_SKY.x, SUN_IN_SKY.y, SUN_IN_SKY.z],
    fogColor: LIGHTING.fog.color,
    warehouse: {
      west: W.west,
      east: W.east,
      north: W.north,
      south: W.south,
      eaves: W.eaves,
      ridge: W.ridge,
      doorWest: W.door.west,
      doorEast: W.door.east,
      mezzanine: { east: W.mezzanine.east, north: W.mezzanine.north, south: W.mezzanine.south, top: W.mezzanine.top },
    },
    office: { ...OFFICE },
    glows: railyardGlows(),
  };
  return { byFingerprint, aoGraphs, params };
}

/** Reference programs for a map, or null when the map has no hand-ported programs yet. */
export function programTable(mapId: string, ctx: MapBuildContext): ProgramTable | null {
  switch (mapId) {
    case 'railyard':
      return railyardPrograms(ctx);
    case 'headworks':
      return headworksPrograms(ctx);
    case 'harbor':
      return harborPrograms(ctx);
    case 'range':
      return rangePrograms(ctx);
    default:
      return null;
  }
}

/** The program name for a live material, or null when it matches no reference. */
export function programOf(table: ProgramTable | null, material: THREE.Material): string | null {
  return table?.classify?.(material)?.program ?? table?.byFingerprint.get(fingerprint(material)) ?? null;
}

/** The factory arguments of a live material's program (Harbor families), or null. */
export function programArgsOf(table: ProgramTable | null, material: THREE.Material): number[] | null {
  return table?.classify?.(material)?.args ?? null;
}

/** The named emission program of a live material's emissiveNode, or null. */
export function emissiveProgramOf(table: ProgramTable | null, material: THREE.Material): string | null {
  const node = (material as unknown as { emissiveNode?: unknown }).emissiveNode;
  if (!table?.emissiveGraphs || !node) return null;
  return table.emissiveGraphs.get(graphKey(node, new Map(), new Set())) ?? null;
}

/** The named ambient-occlusion program of a live material's aoNode, or null. */
export function aoProgramOf(table: ProgramTable | null, material: THREE.Material): string | null {
  const ao = (material as unknown as { aoNode?: unknown }).aoNode;
  if (!table || !ao) return null;
  return table.aoGraphs.get(graphKey(ao, new Map(), new Set())) ?? null;
}

/**
 * The first texture each node slot samples (`texture(maps.color, uv())` in a colour node, the
 * normal map inside soak()'s normal node), for programs whose texture is not in a material slot.
 */
export function nodeTexturesOf(material: THREE.Material): Partial<Record<(typeof NODE_SLOTS)[number], THREE.Texture>> {
  const out: Partial<Record<(typeof NODE_SLOTS)[number], THREE.Texture>> = {};
  const any = material as unknown as Record<string, unknown>;
  for (const slot of NODE_SLOTS) {
    const seen = new Set<unknown>();
    const visit = (node: unknown): THREE.Texture | null => {
      if (!node || typeof node !== 'object' || seen.has(node)) return null;
      seen.add(node);
      if (Array.isArray(node)) {
        for (const c of node) {
          const found = visit(c);
          if (found) return found;
        }
        return null;
      }
      const n = node as AnyNode;
      if (n.isNode !== true) return null;
      if ((n as { isTextureNode?: boolean }).isTextureNode && n.value instanceof THREE.Texture) return n.value;
      for (const key of Object.keys(n).sort()) {
        if (key === 'value' || key === 'parents') continue;
        const found = visit(n[key]);
        if (found) return found;
      }
      return null;
    };
    const found = visit(any[slot]);
    if (found) out[slot] = found;
  }
  return out;
}
