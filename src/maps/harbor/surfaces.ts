import * as THREE from 'three/webgpu';
import {
  abs,
  color,
  dot,
  float,
  floor,
  fract,
  materialNormal,
  materialRoughness,
  min,
  mix,
  mod,
  normalView,
  normalWorld,
  positionViewDirection,
  positionWorld,
  smoothstep,
  step,
  texture,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import type { PbrMaps } from '../../core/assets';
import { flatMaterial, pbrMaterial } from '../../render/materials';
import { grimeSampler, groundCoord, heightAboveStreet, wallCoord, type TslNode } from './grime';

type Standard = THREE.MeshStandardNodeMaterial;

const LUMA = vec3(0.2126, 0.7152, 0.0722);
const WHITE = vec3(1, 1, 1);

/** Brightness of a scanned colour map around its mean: the scan's dirt and relief without its hue. */
const relief = (maps: PbrMaps, mean: number, low: number, high: number): TslNode =>
  dot(texture(maps.color, uv()).rgb, LUMA).div(mean).clamp(low, high);

/** Noise coordinate that works on walls and on flat tops alike. */
const surfaceCoord: TslNode = mix(wallCoord, groundCoord, step(0.7, abs(normalWorld.y)));

/**
 * Plaster recoloured from a scanned set. The scan supplies trowel marks as
 * brightness and the tint supplies the hue; on top of that come broad
 * blotches, drip streaks, rising damp at the foot of the wall and patches
 * where the colour coat has fallen off the render. `wear` scales the damage.
 */
export function plaster(maps: PbrMaps, tint: number, meanLuma: number, grime: THREE.Texture, wear = 1, roughness = 1): Standard {
  const material = pbrMaterial(maps, { roughness });
  const g = grimeSampler(grime);
  const detail = relief(maps, meanLuma, 0.5, 1.4);
  const blotch = g(surfaceCoord, 9.3).r;
  const fine = g(surfaceCoord, 1.9).b;
  const drips = smoothstep(0.5, 0.92, g(surfaceCoord, 6.1, 0.21).g).mul(mix(float(0.3), float(1), blotch)).mul(wear);
  const damp = smoothstep(0.05, 1.7, heightAboveStreet.add(blotch.sub(0.5).mul(1.5))).oneMinus().mul(wear);

  // Soot and rain: long soft runs down the whole wall, wider than the drips and independent of them.
  const runs = smoothstep(0.42, 0.8, g(vec2(surfaceCoord.x, surfaceCoord.y.mul(0.22)), 3.7, 0.63).g).mul(mix(float(0.35), float(1), g(surfaceCoord, 13.1, 0.2).a)).mul(wear);
  const shade = detail
    .mul(mix(float(0.76), float(1.09), blotch))
    .mul(mix(float(1), float(0.62), drips))
    .mul(mix(float(1), float(0.8), runs))
    .mul(mix(float(1), float(0.52), damp));
  const coat = color(tint).mul(shade).mul(mix(WHITE, vec3(0.88, 0.92, 0.76), damp.mul(0.7)));

  const nearGround = smoothstep(0.3, 5, heightAboveStreet).oneMinus();
  const islands = g(surfaceCoord, 8.3, 0.37).a.add(fine.sub(0.5).mul(0.07)).add(nearGround.mul(0.07));
  const peel = smoothstep(0.82, 0.84, islands).mul(wear);
  // The render under the paint: a sandy grey that has taken up some of the wall's colour.
  const render = mix(color(0xb5a68d), color(tint), 0.22).mul(detail).mul(mix(float(0.78), float(1), fine)).mul(mix(float(1), float(0.66), damp));
  material.colorNode = mix(coat, render, peel.mul(0.85));
  return material;
}

export interface MasonryOptions {
  readonly roughness?: number;
  /** Size of dressed slabs on up-facing surfaces, in metres. Omit for rubble. */
  readonly slab?: readonly [number, number];
}

/**
 * Harbour stone: recoloured scan with blotches, plus weed and wet below the
 * quay level, where the tide reaches. With `slab`, flat tops are cut into
 * paving slabs in a running bond.
 */
export function masonry(maps: PbrMaps, tint: number, meanLuma: number, grime: THREE.Texture, options: MasonryOptions = {}): Standard {
  const material = pbrMaterial(maps, { roughness: options.roughness ?? 1 });
  const g = grimeSampler(grime);
  const detail = relief(maps, meanLuma, 0.5, 1.4);
  const blotch = g(surfaceCoord, 7.3).r;
  const drips = smoothstep(0.55, 0.95, g(surfaceCoord, 5.3, 0.4).g);
  let shade: TslNode = detail.mul(mix(float(0.8), float(1.08), blotch)).mul(mix(float(1), float(0.8), drips));

  if (options.slab) {
    const [sx, sz] = options.slab;
    const row = floor(positionWorld.z.div(sz));
    const along = positionWorld.x.div(sx).add(mod(row, 2).mul(0.5));
    const fx = fract(along);
    const fz = fract(positionWorld.z.div(sz));
    const edge = min(min(fx, fx.oneMinus()).mul(sx), min(fz, fz.oneMinus()).mul(sz));
    const flat = step(0.7, normalWorld.y);
    const joint = smoothstep(0.004, 0.022, edge).oneMinus().mul(flat);
    const each = texture(grime, vec2(floor(along), row).mul(0.173)).r;
    shade = shade.mul(mix(float(1), mix(float(0.82), float(1.1), each), flat)).mul(mix(float(1), float(0.5), joint));
  }

  const tide = smoothstep(-0.8, -0.12, positionWorld.y.add(blotch.sub(0.5).mul(0.35))).oneMinus();
  material.colorNode = mix(color(tint).mul(shade), color(0x2b3220).mul(detail), tide.mul(0.8));
  material.roughnessNode = mix(materialRoughness, float(0.3), tide);
  return material;
}

/**
 * Cobbles after a shower: broad colour drift so the sheet does not read as
 * one tile, dark damp patches, and puddles that fill the joints first and
 * mirror the sky.
 */
export function cobbles(maps: PbrMaps, grime: THREE.Texture, coverage: number): Standard {
  const material = pbrMaterial(maps, { normalScale: 1.2 });
  const g = grimeSampler(grime);
  const macro = g(groundCoord, 19).r;
  const warm = g(groundCoord, 6.7, 0.5).b;
  const joints = maps.arm ? texture(maps.arm, uv()).r.oneMinus() : float(0);
  const pool = g(groundCoord, 7.1, 0.13).a.mul(0.7).add(g(groundCoord, 2.9).r.mul(0.3));
  const threshold = 1 - coverage;
  const level = smoothstep(0.985, 0.999, normalWorld.y);
  const damp = smoothstep(threshold - 0.16, threshold, pool).mul(level);
  const puddle = smoothstep(threshold, threshold + 0.1, pool.add(joints.sub(0.25).mul(0.3))).mul(level);
  // Weed and wet where the slipway runs into the sea.
  const tide = smoothstep(-0.7, -0.05, positionWorld.y).oneMinus();

  const base = texture(maps.color, uv()).rgb.mul(mix(float(0.8), float(1.1), macro)).mul(mix(WHITE, vec3(1.08, 1.0, 0.88), warm));
  const wet = base.mul(mix(float(1), float(0.62), damp)).mul(mix(float(1), float(0.55), puddle));
  material.colorNode = mix(wet, color(0x283020), tide.mul(0.7));
  material.roughnessNode = mix(materialRoughness.mul(mix(float(1), float(0.6), damp)), float(0.1), puddle.max(tide.mul(0.7)));
  material.normalNode = mix(materialNormal, normalView, puddle.mul(0.92)).normalize();
  return material;
}

/** Roof tiles with weathering: batches of older, darker tiles and lichen in patches. */
export function roofTiles(maps: PbrMaps, tint: number, grime: THREE.Texture): Standard {
  const material = pbrMaterial(maps, { tint, normalScale: 1.4 });
  const g = grimeSampler(grime);
  const macro = g(groundCoord, 7.9).r;
  const fine = g(groundCoord, 1.3).b;
  const lichen = smoothstep(0.6, 0.72, g(groundCoord, 4.9, 0.6).a);
  const base = texture(maps.color, uv()).rgb.mul(color(tint)).mul(mix(float(0.66), float(1.12), macro)).mul(mix(float(0.86), float(1.06), fine));
  material.colorNode = mix(base, color(0x7d7b5c).mul(mix(float(0.7), float(1.1), fine)), lichen.mul(0.4));
  return material;
}

/** Scanned timber recoloured to a stain or to weathered grey; no flaking. */
export function stained(maps: PbrMaps, tint: number, meanLuma: number, grime: THREE.Texture, roughness = 0.95): Standard {
  const material = pbrMaterial(maps, { roughness });
  const blotch = grimeSampler(grime)(surfaceCoord, 3.1).r;
  material.colorNode = color(tint).mul(relief(maps, meanLuma, 0.45, 1.4)).mul(mix(float(0.78), float(1.08), blotch));
  return material;
}

/** Scanned planks under old paint: grain, gaps and the scan's own flaking survive as shading under the new colour. */
export function painted(maps: PbrMaps, tint: number, grime: THREE.Texture): Standard {
  const material = pbrMaterial(maps, { roughness: 0.95 });
  const detail = relief(maps, 0.2, 0.35, 1.3);
  const wear = grimeSampler(grime)(surfaceCoord, 0.83).b;
  material.colorNode = color(tint).mul(detail).mul(mix(float(0.74), float(1.06), wear));
  return material;
}

/**
 * Louvred shutter in old paint. The slats are shading only: each one catches
 * light on its upper edge and throws a line of shadow under it, and the
 * surface normal rocks with them so the sun rakes across the leaf.
 */
export function louvred(maps: PbrMaps, tint: number, grime: THREE.Texture): Standard {
  const material = pbrMaterial(maps, { roughness: 0.9 });
  const g = grimeSampler(grime);
  const wear = g(surfaceCoord, 0.83).b;
  const flake = smoothstep(0.78, 0.84, g(surfaceCoord, 1.3, 0.3).a.add(wear.sub(0.5).mul(0.25)));
  const slat = fract(positionWorld.y.div(0.052));
  const shade = mix(float(0.42), float(1.08), smoothstep(0.0, 0.3, slat)).mul(mix(float(1), float(0.86), smoothstep(0.8, 1, slat)));
  const coat = color(tint).mul(mix(float(0.74), float(1.06), wear));
  material.colorNode = mix(coat, color(0x8c8272).mul(mix(float(0.7), float(1.05), wear)), flake.mul(0.55)).mul(shade);
  material.normalNode = normalView.add(vec3(0, slat.sub(0.5).mul(0.9), 0)).normalize();
  return material;
}

/**
 * Lit room seen through a window: lamp glow that is brightest low down and
 * uneven from pane to pane, with the soft dark shapes of curtains and
 * furniture, rather than one flat orange card.
 */
export function litRoom(grime: THREE.Texture): Standard {
  const material = flatMaterial(0x1a120b, 0.25);
  const g = grimeSampler(grime);
  const folds = g(vec2(wallCoord.x, wallCoord.y.mul(0.12)), 0.9).g;
  const shapes = g(wallCoord, 2.7, 0.13).a;
  const room = g(wallCoord, 7.5, 0.6).r;
  const curtain = smoothstep(0.35, 0.75, folds).mul(0.55);
  const furniture = smoothstep(0.5, 0.75, shapes).mul(0.4);
  const glow = mix(float(0.55), float(1.5), room).mul(float(1).sub(curtain)).mul(float(1).sub(furniture));
  material.emissiveNode = mix(color(0xff8a3a), color(0xffc26e), room).mul(glow).mul(2.6);
  return material;
}

/**
 * Lantern glass with a flame behind it: hot where the pane is seen square on,
 * falling away to a dull amber at glancing angles, so a lantern reads as panes
 * around a light instead of one burnt-out white block.
 */
export function lampGlass(tint: number, peak: number): Standard {
  const material = flatMaterial(0x2a2015, 0.5);
  const square = dot(normalView, positionViewDirection).abs();
  material.emissiveNode = color(tint).mul(mix(float(peak * 0.16), float(peak), square.pow(2.5)));
  return material;
}

/** Striped awning canvas, sun-faded and grubby. */
export function striped(stripe: number, repeat: number, grime: THREE.Texture): Standard {
  const material = flatMaterial(0xffffff, 0.92);
  const g = grimeSampler(grime);
  const band = step(0.5, fract(uv().x.mul(repeat)));
  const fade = g(positionWorld.xz.add(positionWorld.y), 2.3).r;
  const dirt = g(positionWorld.xz.add(positionWorld.y), 0.9).b;
  material.colorNode = mix(color(0xe4d9c0), color(stripe), band.mul(mix(float(0.7), float(1), fade))).mul(mix(float(0.72), float(1.02), dirt));
  material.side = THREE.DoubleSide;
  return material;
}

/** Flat colour with scuffs: moulded plastic, painted hulls, floats. */
export function scuffed(tint: number, roughness: number, grime: THREE.Texture): Standard {
  const material = flatMaterial(0xffffff, roughness);
  const g = grimeSampler(grime);
  const coord = positionWorld.xz.add(positionWorld.y.mul(0.7));
  material.colorNode = color(tint).mul(mix(float(0.66), float(1.06), g(coord, 0.47).b)).mul(mix(float(0.85), float(1.05), g(coord, 2.1).r));
  return material;
}

const HAZE_TINT = 0xa9adb2;

/**
 * Aerial perspective for the mountain and what grows on it. The scene fog is
 * tuned for the streets and barely touches the hill, which left it as crisp
 * as the houses in front of it; this lays pale air over it, thicker with
 * distance north of the top terrace.
 */
export function distantHaze(surface: TslNode): TslNode {
  const far = smoothstep(62, 230, positionWorld.z.negate()).mul(0.3).add(smoothstep(55, 75, positionWorld.z.negate()).mul(0.08));
  return mix(surface, color(HAZE_TINT), far);
}

/**
 * Mountainside: pale limestone on the steep faces, dry grass on the slopes
 * and dark macchia scrub in drifts. Colour comes from noise at four scales so
 * nothing repeats at the distance it is seen from.
 */
export function hillside(maps: PbrMaps, grime: THREE.Texture): Standard {
  const material = pbrMaterial(maps, { normalScale: 1.8 });
  const g = grimeSampler(grime);
  const broad = g(groundCoord, 230).r;
  const drift = g(groundCoord, 61, 0.3).a;
  const fine = g(groundCoord, 13).b;
  const tiny = g(groundCoord, 3.1, 0.7).b;
  const rockDetail = relief(maps, 0.15, 0.6, 1.5);
  // The whole face is steep, so only the cliffs proper (past about 65 degrees) are bare rock.
  const steep = smoothstep(0.26, 0.42, normalWorld.y.add(drift.sub(0.5).mul(0.3))).oneMinus();
  // Macchia covers most of the slope, in the same greens as the trees standing on it, so they read as one wood.
  // The low orange sun takes most of the green out of anything it lights, so these are greener than they will look.
  const scrub = smoothstep(0.2, 0.36, broad.mul(0.45).add(drift.mul(0.55)).add(fine.sub(0.5).mul(0.3)));
  const grass = color(0x5d5a33).mul(mix(float(0.7), float(1.15), fine)).mul(mix(float(0.8), float(1.1), rockDetail));
  const macchia = mix(color(0x14301a), color(0x42702c), tiny.mul(0.6).add(fine.mul(0.4))).mul(mix(float(0.7), float(1.1), drift));
  const rock = color(0x8d8270).mul(rockDetail).mul(mix(float(0.8), float(1.08), fine));
  // Dry-stone terraces on the lower slopes: a pale wall every few metres of height, in patches.
  const step4 = fract(positionWorld.y.div(4.4).add(fine.mul(0.16)));
  const farmed = smoothstep(0.5, 0.62, g(groundCoord, 97, 0.55).a).mul(smoothstep(60, 95, positionWorld.y).oneMinus()).mul(steep.oneMinus());
  const wallLine = smoothstep(0.86, 0.9, step4).mul(farmed);
  const plot = mix(color(0x77703f), color(0x55633a), tiny).mul(mix(float(0.8), float(1.1), fine));
  const ground = mix(mix(mix(grass, macchia, scrub), plot, farmed.mul(0.85)), color(0xa59a84).mul(rockDetail), wallLine);
  material.colorNode = distantHaze(mix(ground, rock, steep));
  material.roughnessNode = float(1);
  return material;
}

/** Leaves seen as a mass: mottled greens and a broken-up normal so the clump does not shade like a ball. */
export function leafy(dark: number, light: number, grime: THREE.Texture, grain = 0.09): Standard {
  const material = flatMaterial(0xffffff, 0.85);
  const g = grimeSampler(grime);
  const coord = positionWorld.xz.add(positionWorld.y.mul(0.61));
  const a = g(coord, grain).b;
  const b = g(coord.add(positionWorld.y), grain * 1.7, 0.4).r;
  material.colorNode = distantHaze(mix(color(dark), color(light), a.mul(0.65).add(b.mul(0.35))).mul(mix(float(0.55), float(1.1), b)));
  material.normalNode = normalView.add(vec3(a.sub(0.5), b.sub(0.5), a.mul(b).sub(0.25)).mul(1.1)).normalize();
  return material;
}
