// Harbor surface programs (PLAN.md 3.4, M9). Harbor builds most of its materials from
// parameterised factories (plaster in seven tints, five painted woods, ...), so besides exact
// fingerprints this table has families: a probe material from each factory, built with odd
// argument values, gives the factory's family fingerprint (constants masked) and the positions
// of its arguments among its node constants. A live material of the family is the program, and
// its constants at those positions are its arguments (scene.json `programArgs`, read by
// Shaders/MapHarbor*.metal). Map-wide textures (grime atlas, shade bake, wave slopes, boat
// lettering) are found in the live level; plan numbers are float4 rows (IV_HB_* in MapSurface.h).
import * as THREE from 'three/webgpu';
import type { MapBuildContext } from '../../../../src/game/contracts';
import { CollisionWorld } from '../../../../src/world/collision';
import { addBoats } from '../../../../src/maps/harbor/boats';
import { addCapes } from '../../../../src/maps/harbor/capes';
import type { Kit } from '../../../../src/maps/harbor/facade';
import { addGlow } from '../../../../src/maps/harbor/glow';
import { DRAFT } from '../../../../src/maps/harbor/hull-shape';
import { Batch, Colliders } from '../../../../src/maps/harbor/kit';
import { ALLEY, JETTIES, MOLE, QUAY_EDGE, RAMP, SLIPWAY, TERRACE_Y, WATER_Y } from '../../../../src/maps/harbor/layout';
import { HDRI_SUN_AZIMUTH, HDRI_SUN_ELEVATION, LIGHTING } from '../../../../src/maps/harbor/lighting';
import { createMaterials } from '../../../../src/maps/harbor/materials';
import { createShadeMap, shadeLit, shadeTerms } from '../../../../src/maps/harbor/shade';
import { HEIGHT_FLOOR, HEIGHT_RANGE, SHADE_GRID, TIER_Y, TIER_Z } from '../../../../src/maps/harbor/shade-grid';
import { addSky } from '../../../../src/maps/harbor/sky';
import {
  cobbles,
  hillside,
  lampGlass,
  leafy,
  litRoom,
  louvred,
  masonry,
  painted,
  plaster,
  roofTiles,
  scuffed,
  stainDecal,
  stained,
  striped,
  treeShadow,
} from '../../../../src/maps/harbor/surfaces';
import { createSea } from '../../../../src/maps/harbor/water';
import { constantsOf, fingerprint, graphKey, namePrograms, texturesIn, type ProgramTable } from './programs';

/** sky.ts: the drawn panorama is lifted like the engine backdrop (1.5), the raw HDR is not. */
const PANORAMA_LIFT = 1.5;

/** An argument of a factory: a colour (three linear numbers) or a number, and the value the probe passes. */
type Arg = { readonly color: number } | { readonly number: number; readonly appearsAs?: (v: number) => number };

interface Family {
  readonly program: string;
  /** Builds the factory's material with the given probe values, in the order of `args`. */
  readonly build: (probe: readonly number[]) => THREE.Material;
  readonly args: readonly Arg[];
}

const probeOf = (a: Arg): number => ('color' in a ? a.color : a.number);

/** Where each argument sits among the family's node constants. */
function argumentPositions(family: Family, material: THREE.Material): number[] {
  const constants = constantsOf(material);
  return family.args.map((arg, i) => {
    const at = constants.findIndex((c) => {
      if ('color' in arg) return c instanceof THREE.Color && c.getHex() === arg.color;
      const want = arg.appearsAs ? arg.appearsAs(arg.number) : arg.number;
      return typeof c === 'number' && Math.abs(c - want) < 1e-9;
    });
    if (at < 0) throw new Error(`harbor family ${family.program}: argument ${i} not found among its constants`);
    return at;
  });
}

function argumentValues(family: Family, positions: readonly number[], material: THREE.Material): number[] {
  const constants = constantsOf(material);
  return family.args.flatMap((arg, i) => {
    const c = constants[positions[i]!];
    if ('color' in arg) {
      if (!(c instanceof THREE.Color)) throw new Error(`harbor family ${family.program}: argument ${i} is not a colour`);
      return [c.r, c.g, c.b];
    }
    if (typeof c !== 'number') throw new Error(`harbor family ${family.program}: argument ${i} is not a number`);
    return [c];
  });
}

export function harborPrograms(ctx: MapBuildContext): ProgramTable {
  const { assets } = ctx;
  const mats = createMaterials(assets);
  const grime = mats.grime;
  const terms = shadeTerms(mats.shade);
  const yellow = assets.pbr('pbr-harbor-plaster-yellow');
  const white = assets.pbr('pbr-harbor-plaster-white');
  const stone = assets.pbr('pbr-harbor-stone');
  const planks = assets.pbr('pbr-harbor-planks');
  const blue = assets.pbr('pbr-harbor-blue-planks');
  const cobble = assets.pbr('pbr-harbor-cobble');
  const roof = assets.pbr('pbr-harbor-roof-tiles');

  // Probe values are odd so they match no other constant of the factory.
  const families: Family[] = [
    ...[yellow, white].map((maps): Family => ({
      program: 'plaster',
      build: ([t, m, w]) => plaster(maps, t!, m!, grime, w!, 0.913),
      args: [{ color: 0x123457 }, { number: 0.2317 }, { number: 0.4321 }],
    })),
    { program: 'masonry', build: ([t, m]) => masonry(stone, t!, m!, grime), args: [{ color: 0x123457 }, { number: 0.1713 }] },
    {
      program: 'masonrySlab',
      build: ([t, m, x, z]) => masonry(white, t!, m!, grime, { roughness: 0.913, slab: [x!, z!] }),
      args: [{ color: 0x123457 }, { number: 0.1713 }, { number: 1.1171 }, { number: 0.6173 }],
    },
    // The threshold node is float(1 - coverage).
    { program: 'cobbles', build: ([c]) => cobbles(cobble, grime, c!, terms), args: [{ number: 0.3711, appearsAs: (v) => 1 - v }] },
    { program: 'roofTiles', build: ([t]) => roofTiles(roof, t!, grime), args: [{ color: 0x123457 }] },
    { program: 'stained', build: ([t, m]) => stained(planks, t!, m!, grime, 0.913), args: [{ color: 0x123457 }, { number: 0.0617 }] },
    { program: 'painted', build: ([t]) => painted(blue, t!, grime), args: [{ color: 0x123457 }] },
    { program: 'louvred', build: ([t]) => louvred(blue, t!, grime), args: [{ color: 0x123457 }] },
    { program: 'litRoom', build: () => litRoom(grime), args: [] },
    { program: 'lampGlass', build: ([t, p]) => lampGlass(t!, p!), args: [{ color: 0x123457 }, { number: 7.4713 }] },
    { program: 'striped', build: ([t, r]) => striped(t!, r!, grime), args: [{ color: 0x123457 }, { number: 5.1371 }] },
    { program: 'scuffed', build: ([t]) => scuffed(t!, 0.913, grime), args: [{ color: 0x123457 }] },
    // tarpaulin() in materials.ts: scuffed, double-sided.
    {
      program: 'scuffed',
      build: ([t]) => Object.assign(scuffed(t!, 0.913, grime), { side: THREE.DoubleSide }),
      args: [{ color: 0x123457 }],
    },
    { program: 'stainDecal', build: () => stainDecal(grime), args: [] },
    { program: 'hillside', build: () => hillside(stone, grime), args: [] },
    { program: 'treeShadow', build: () => treeShadow(), args: [] },
    {
      program: 'leafy',
      build: ([d, l, g]) => leafy(d!, l!, grime, g!),
      args: [{ color: 0x123457 }, { color: 0x345679 }, { number: 0.0937 }],
    },
  ];
  // shadeLit() is applied after the factory and changes no node slot the family fingerprint reads.
  const byFamily = new Map<string, { family: Family; positions: number[] }>();
  for (const family of families) {
    const probe = family.build(family.args.map(probeOf));
    const key = fingerprint(probe, true);
    const clash = byFamily.get(key);
    if (clash && clash.family.program !== family.program) throw new Error(`harbor families ${clash.family.program} and ${family.program} share a fingerprint`);
    byFamily.set(key, { family, positions: argumentPositions(family, probe) });
    probe.dispose();
  }

  // One-off materials: sky dome, sea, lamp pools, horizon haze and the boats.
  const kit: Kit = { batch: new Batch(), colliders: new Colliders(new CollisionWorld()), mats, random: ctx.random, density: ctx.detailDensity, lanterns: [] };
  const root = new THREE.Group();
  addSky(root, assets);
  const sea = createSea(kit.random);
  addCapes(kit, root);
  addBoats(kit, root, assets);
  kit.lanterns.push([0, 3, 0, 0, 1]);
  addGlow(kit, root);
  const byName = (name: string): THREE.Material => {
    const mesh = root.getObjectByName(name) as THREE.Mesh | undefined;
    if (!mesh || Array.isArray(mesh.material)) throw new Error(`harbor reference ${name} not found`);
    return mesh.material;
  };
  const byFingerprint = namePrograms('harbor', [
    ['sky', byName('harbor-sky')],
    ['sea', sea.material],
    ['glow', byName('harbor-glow')],
    ['haze', byName('harbor-haze')],
    ['boat', byName('harbor-boat')],
  ]);

  const aoGraphs = new Map<string, string>();
  const emissiveGraphs = new Map<string, string>();
  for (const withMap of [false, true]) {
    const probe = new THREE.MeshStandardNodeMaterial();
    if (withMap) probe.aoMap = new THREE.Texture();
    shadeLit(probe, shadeTerms(createShadeMap()));
    aoGraphs.set(graphKey(probe.aoNode, new Map(), new Set()), 'harborShade');
    emissiveGraphs.set(graphKey(probe.emissiveNode, new Map(), new Set()), 'harborBounce');
    probe.dispose();
  }

  const classify = (material: THREE.Material): { program: string; args: number[] } | null => {
    const emissive = (material as unknown as { emissiveNode?: unknown }).emissiveNode;
    const lit = emissive !== undefined && emissive !== null && emissiveGraphs.has(graphKey(emissive, new Map(), new Set()));
    const found = byFamily.get(fingerprint(material, true, lit));
    if (!found) return null;
    return { program: `harbor.${found.family.program}`, args: argumentValues(found.family, found.positions, material) };
  };

  // Live textures: the shade bake exists only in the live level, after its collision world is built.
  const textures = (live: THREE.Object3D): Record<string, THREE.Texture> => {
    const found: Record<string, THREE.Texture> = {};
    const seaKey = fingerprint(sea.material);
    live.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material)) return;
      const m = mesh.material as THREE.Material & Record<string, unknown>;
      if (mesh.name === 'harbor-glow') found.grime ??= texturesIn(m.colorNode)[0]!;
      if (aoGraphs.has(graphKey(m.aoNode, new Map(), new Set()))) found.shade ??= texturesIn(m.aoNode).find((t) => (t.image as { width?: number } | null)?.width === SHADE_GRID.cols)!;
      if (fingerprint(m) === seaKey) found.waves ??= texturesIn(m.normalNode)[0]!;
      if (mesh.name === 'harbor-boat') found.lettering ??= texturesIn(m.opacityNode)[0]!;
    });
    for (const name of ['grime', 'shade', 'waves', 'lettering']) {
      if (!found[name]) throw new Error(`harbor texture ${name} not found in the level`);
    }
    return found;
  };
  sea.dispose();

  const G = SHADE_GRID;
  const panorama = assets.sky(LIGHTING.hdri) !== null;
  const rows: number[][] = [
    [G.x0, G.z0, G.cols * G.cell, G.rows * G.cell], // IV_HB_SHADE_GRID
    [HEIGHT_RANGE, HEIGHT_FLOOR, TERRACE_Y, 0], // IV_HB_HEIGHTS
    [ALLEY.x0, ALLEY.x1, ALLEY.stepsFromZ, ALLEY.risers * ALLEY.tread], // IV_HB_ALLEY
    [RAMP.x0, RAMP.x1, RAMP.z0, RAMP.z1], // IV_HB_RAMP
    [...TIER_Z, 0], // IV_HB_TIER_Z
    [...TIER_Y, 0], // IV_HB_TIER_Y
    [HDRI_SUN_AZIMUTH, HDRI_SUN_ELEVATION, LIGHTING.skyIntensity * (panorama ? PANORAMA_LIFT : 1), 0], // IV_HB_SKY
    [QUAY_EDGE, WATER_Y, DRAFT, JETTIES.length], // IV_HB_WATER
    [MOLE.x1, MOLE.z1, 0, 0], // IV_HB_MOLE
    [SLIPWAY.x0, SLIPWAY.x1, SLIPWAY.z1, 0], // IV_HB_SLIPWAY
    ...JETTIES.map((j) => [j.x, j.width, j.length, j.head]), // IV_HB_JETTIES
  ];
  return { byFingerprint, aoGraphs, emissiveGraphs, rows, classify, textures };
}

