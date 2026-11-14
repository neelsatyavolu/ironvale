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

const NODE_SLOTS = ['colorNode', 'roughnessNode', 'metalnessNode', 'opacityNode', 'normalNode', 'vertexNode', 'positionNode'] as const;
const SCALARS = ['type', 'transparent', 'alphaTest', 'side', 'vertexColors', 'depthWrite', 'fog', 'roughness', 'metalness', 'opacity'] as const;
const MAP_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'alphaMap'] as const;

type AnyNode = Record<string, unknown> & { isNode?: boolean };

/** Structural description of one node graph; memoised per node so shared sub-graphs stay linear. */
function graphKey(node: unknown, memo: Map<unknown, string>, stack: Set<unknown>): string {
  if (typeof node === 'number' || typeof node === 'boolean' || typeof node === 'string') return JSON.stringify(node);
  if (!node || typeof node !== 'object') return '_';
  const known = memo.get(node);
  if (known !== undefined) return known;
  if (stack.has(node)) return '^';
  const n = node as AnyNode;
  if (Array.isArray(node)) return `[${node.map((c) => graphKey(c, memo, stack)).join(',')}]`;
  if (n.isNode !== true) return '_';
  stack.add(node);
  const parts: string[] = [String((n.constructor as { type?: string }).type ?? n.constructor.name)];
  for (const key of ['op', 'method', 'components', 'name', 'scope', 'nodeType']) {
    if (typeof n[key] === 'string') parts.push(`${key}=${n[key] as string}`);
  }
  if ((n as { isConstNode?: boolean }).isConstNode) parts.push(`v=${constValue(n.value)}`);
  for (const key of Object.keys(n).sort()) {
    if (key === 'value' || key.startsWith('_') || key === 'parents' || key === 'uuid') continue;
    const child = n[key];
    if ((child as AnyNode)?.isNode || (Array.isArray(child) && child.some((c) => (c as AnyNode)?.isNode))) {
      parts.push(`${key}:${graphKey(child, memo, stack)}`);
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

function fingerprint(material: THREE.Material): string {
  const any = material as unknown as Record<string, unknown>;
  const memo = new Map<unknown, string>();
  const parts: string[] = [];
  for (const key of SCALARS) parts.push(`${key}=${String(any[key])}`);
  const color = any.color instanceof THREE.Color ? (any.color as THREE.Color).getHex() : -1;
  parts.push(`color=${color}`);
  for (const slot of MAP_SLOTS) parts.push(`${slot}=${any[slot] ? 1 : 0}`);
  for (const slot of NODE_SLOTS) parts.push(`${slot}=${graphKey(any[slot], memo, new Set())}`);
  return parts.join('|');
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
  /** Plan numbers the map's programs read, written to scene.json as `programParams`. */
  readonly params: Record<string, unknown>;
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
  return mapId === 'railyard' ? railyardPrograms(ctx) : null;
}

/** The program name for a live material, or null when it matches no reference. */
export function programOf(table: ProgramTable | null, material: THREE.Material): string | null {
  return table?.byFingerprint.get(fingerprint(material)) ?? null;
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
