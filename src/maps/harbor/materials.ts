import * as THREE from 'three/webgpu';
import type { Assets } from '../../core/assets';
import { seededRandom } from '../../core/random';
import { flatMaterial, pbrMaterial } from '../../render/materials';
import { createGrimeMap } from './grime';
import { createPosterMap, posterMaterial } from './posters';
import { createShadeMap, shadeLit, shadeTerms } from './shade';
import { createSprayMap } from './sprays';
import { cobbles, hillside, lampGlass, leafy, litRoom, louvred, masonry, painted, plaster, roofTiles, scuffed, stainDecal, stained, striped, treeShadow } from './surfaces';

type Standard = THREE.MeshStandardNodeMaterial;

const GRIME_SEED = 0x4a7b0;

export interface HarborMaterials {
  /** Shared noise atlas behind every weathered surface. */
  readonly grime: THREE.DataTexture;
  /** Street lighting in plan; filled by `ShadeBake` once the collision world exists. */
  readonly shade: THREE.DataTexture;
  readonly cobble: Standard;
  readonly stone: Standard;
  /** Paler dressed stone for copings, sills, steps and trim. */
  readonly stoneLight: Standard;
  /** Plaster colours for house walls, in a fixed order. */
  readonly plaster: readonly Standard[];
  readonly plasterWhite: Standard;
  /** Dim plaster for rooms, standing in for the sky light that walls would block. */
  readonly plasterShade: Standard;
  readonly planksShade: Standard;
  readonly roof: Standard;
  readonly planks: Standard;
  readonly planksPale: Standard;
  /** Painted woodwork for shutters and doors, in a fixed order. */
  readonly paint: readonly Standard[];
  /** The same colours as `paint`, in the same order, as louvred shutter leaves. */
  readonly louvre: readonly Standard[];
  readonly glass: Standard;
  readonly glassLit: Standard;
  readonly iron: Standard;
  readonly rope: Standard;
  readonly lamp: Standard;
  readonly terracotta: Standard;
  readonly foliage: Standard;
  readonly net: Standard;
  /** Striped canvas for awnings, in a fixed order. */
  readonly awning: readonly Standard[];
  readonly cloth: readonly Standard[];
  readonly float: Standard;
  readonly brass: Standard;
  /** Mid-brown timber for packing cases and carts. */
  readonly crate: Standard;
  /** Heaped netting, seen as a solid mound. */
  readonly netHeap: Standard;
  /** Moulded fish boxes, in a fixed order. */
  readonly fishBox: readonly Standard[];
  /** Dry scrub on the hill behind the town. */
  readonly hill: Standard;
  /** Cut-out leaf sprays for creepers, pot plants and window boxes. U 0 - 0.5 is plain leaves, 0.5 - 1 is in flower. */
  readonly spray: Standard;
  /** Weathered tarpaulin over the laid-up boat. */
  readonly tarp: Standard;
  /** Stacked sacking. */
  readonly sack: Standard;
  /** Green glass of the harbour light on the mole. */
  readonly lampGreen: Standard;
  /** Dull cast iron for covers and old ironwork, without the sheen of the painted railings. */
  readonly castIron: Standard;
  readonly cypress: Standard;
  /** Dark run-off under sills, pipes and drains. UV V is 1 at the source and fades to 0. */
  readonly stain: Standard;
  /** Bill posters, painted wall advertisements and case stencils; cells come from posters.ts. */
  readonly poster: Standard;
  /** Soft ellipse under each tree on the hill. */
  readonly treeShadow: THREE.MeshBasicNodeMaterial;
  /** Dull zinc for gutters, meter cabinets and strapping. */
  readonly zinc: Standard;
  /** Pale worn battens on packing cases. */
  readonly crateTrim: Standard;
  /** Pine canopies and scrub on the hill, seen from far off. */
  readonly pine: Standard;
}

/** Square mesh pattern with a clear centre, for fishing nets and lobster pots. */
function netTexture(): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Diamond mesh: strands run on both diagonals.
      const line = (x + y) % 16 < 2 || (x - y + size) % 16 < 2;
      const i = (y * size + x) * 4;
      // The alpha map is read from the colour channels, so the mask goes in all four.
      const value = line ? 255 : 0;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      data[i + 3] = value;
    }
  }
  const map = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.needsUpdate = true;
  return map;
}

function tarpaulin(tint: number, grime: THREE.Texture): Standard {
  const material = scuffed(tint, 0.9, grime);
  material.side = THREE.DoubleSide;
  return material;
}

function cloth(tint: number): Standard {
  const material = flatMaterial(tint, 0.95);
  material.side = THREE.DoubleSide;
  return material;
}

export function createMaterials(assets: Assets): HarborMaterials {
  const yellow = assets.pbr('pbr-harbor-plaster-yellow');
  const white = assets.pbr('pbr-harbor-plaster-white');
  const stoneMaps = assets.pbr('pbr-harbor-stone');
  const plankMaps = assets.pbr('pbr-harbor-planks');
  const blueMaps = assets.pbr('pbr-harbor-blue-planks');
  // Its own fixed seed: the atlas is cosmetic, and drawing it from the map's stream would shift every placement after it.
  const grime = createGrimeMap(seededRandom(GRIME_SEED));
  const shade = createShadeMap();
  const terms = shadeTerms(shade);

  const net = flatMaterial(0x5a7a6c, 0.9);
  net.alphaMap = netTexture();
  // Below the mesh's average coverage, so distant netting closes up into a haze instead of vanishing.
  net.alphaTest = 0.3;
  net.side = THREE.DoubleSide;

  const spray = new THREE.MeshStandardNodeMaterial({
    map: createSprayMap(seededRandom(GRIME_SEED + 1)),
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    roughness: 0.8,
  });

  const glassLit = litRoom(grime);
  const lampGreen = flatMaterial(0x0f2a1c, 0.4);
  lampGreen.emissive = new THREE.Color(0x4dff9a);
  lampGreen.emissiveIntensity = 6;
  const lamp = lampGlass(0xffb463, 7.5);

  const mats: HarborMaterials = {
    grime,
    shade,
    cobble: cobbles(assets.pbr('pbr-harbor-cobble'), grime, 0.39, terms),
    // Rubble masonry, lifted from the scan's dark brown to a sun-bleached harbour stone.
    stone: masonry(stoneMaps, 0xa3957e, 0.15, grime),
    // Dressed limestone: the rough plaster scan reads as worn ashlar once it is tinted and jointed.
    stoneLight: masonry(white, 0xa99e88, 0.2, grime, { roughness: 0.9, slab: [1.1, 0.62] }),
    plaster: [
      plaster(yellow, 0xd9a655, 0.24, grime), // ochre
      plaster(yellow, 0xd98f6c, 0.24, grime), // salmon
      plaster(white, 0xe6dcc6, 0.2, grime), // cream
      plaster(yellow, 0xc4673f, 0.24, grime), // terracotta
      plaster(white, 0xcfd6d2, 0.2, grime), // pale grey-blue
      plaster(yellow, 0xe3c27a, 0.24, grime), // straw
      plaster(white, 0xd9b9a0, 0.2, grime), // dusty pink
    ],
    plasterWhite: plaster(white, 0xebe5d6, 0.2, grime, 0.4),
    plasterShade: plaster(white, 0x6f685b, 0.2, grime, 0.5),
    planksShade: pbrMaterial(plankMaps, { tint: 0x8c8274 }),
    roof: roofTiles(assets.pbr('pbr-harbor-roof-tiles'), 0xe2c4ae, grime),
    planks: pbrMaterial(plankMaps, { tint: 0xd9c9b4 }),
    // Sun-bleached decking: same grain, recoloured to driftwood grey.
    planksPale: stained(plankMaps, 0x9c8f7c, 0.06, grime),
    paint: [
      pbrMaterial(blueMaps, { roughness: 0.95 }), // faded blue as scanned
      painted(blueMaps, 0x3d6b4a, grime), // green
      painted(blueMaps, 0x7c3a2b, grime), // oxblood
      painted(blueMaps, 0x8a8f86, grime), // grey
      painted(blueMaps, 0x2f5f86, grime), // strong blue
    ],
    louvre: [louvred(blueMaps, 0x5d7f9c, grime), louvred(blueMaps, 0x3d6b4a, grime), louvred(blueMaps, 0x7c3a2b, grime), louvred(blueMaps, 0x8a8f86, grime), louvred(blueMaps, 0x2f5f86, grime)],
    glass: flatMaterial(0x56626d, 0.06, 0.9),
    glassLit,
    iron: flatMaterial(0x1a1b1d, 0.55, 0.75),
    rope: scuffed(0xa8926a, 0.95, grime),
    lamp,
    terracotta: scuffed(0xa9583a, 0.85, grime),
    foliage: leafy(0x1f3216, 0x567a30, grime),
    net,
    awning: [striped(0xa5392f, 5, grime), striped(0x2f5f86, 5, grime), striped(0x3d6b4a, 4, grime), striped(0xc98a2b, 6, grime)],
    cloth: [cloth(0xe8e2d4), cloth(0x9db4c8), cloth(0xb5483a), cloth(0xd9b55a), cloth(0x5d7f6a)],
    float: scuffed(0xd4622a, 0.6, grime),
    brass: flatMaterial(0xb08d4a, 0.35, 1),
    crate: stained(plankMaps, 0x8f6d47, 0.06, grime),
    netHeap: scuffed(0x26403b, 0.95, grime),
    sack: scuffed(0xb39c74, 0.95, grime),
    tarp: tarpaulin(0x6f7458, grime),
    spray,
    lampGreen,
    castIron: scuffed(0x34302c, 0.82, grime),
    stain: stainDecal(grime),
    treeShadow: treeShadow(),
    poster: posterMaterial(createPosterMap(seededRandom(GRIME_SEED + 2))),
    zinc: scuffed(0x4f5456, 0.55, grime),
    crateTrim: stained(plankMaps, 0xa78c63, 0.06, grime),
    hill: hillside(stoneMaps, grime),
    cypress: leafy(0x10301a, 0x35662c, grime, 1.9),
    pine: leafy(0x1a3a1c, 0x55802f, grime, 2.6),
    fishBox: [scuffed(0x2c5d8a, 0.55, grime), scuffed(0xc9cdc8, 0.55, grime), scuffed(0xa8402f, 0.55, grime), scuffed(0xd0a030, 0.55, grime)],
  };
  // Everything that stands in the street takes the baked shade; rooms, glass, lamps and the far hill keep their own light.
  const outdoors: readonly Standard[] = [
    mats.cobble, mats.stone, mats.stoneLight, ...mats.plaster, mats.plasterWhite, mats.planks, mats.planksPale, ...mats.paint, ...mats.louvre,
    mats.iron, mats.rope, mats.terracotta, mats.foliage, ...mats.awning, ...mats.cloth, mats.float, mats.crate, mats.netHeap, ...mats.fishBox,
    mats.spray, mats.tarp, mats.sack, mats.castIron, mats.poster, mats.zinc, mats.crateTrim,
  ];
  for (const material of outdoors) shadeLit(material, terms);
  return mats;
}

export function disposeMaterials(materials: HarborMaterials): void {
  const { grime, shade, ...rest } = materials;
  for (const value of Object.values(rest)) {
    const list: readonly THREE.Material[] = Array.isArray(value) ? value : [value as THREE.Material];
    for (const material of list) material.dispose();
  }
  materials.net.alphaMap?.dispose();
  materials.spray.map?.dispose();
  materials.poster.map?.dispose();
  grime.dispose();
  shade.dispose();
}
