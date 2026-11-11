import * as THREE from 'three/webgpu';
import { abs, attribute, color, float, mix, positionLocal, smoothstep, step, texture, vec2 } from 'three/tsl';
import type { Assets } from '../../core/assets';
import { addClutter, addFenders, addJoinery, addMast, addOars, addOutboard, addWheelhouse, type BoatSpec } from './boat-fittings';
import { mergeBoat, slackLine, type Point } from './boat-parts';
import type { Kit } from './facade';
import { grimeSampler, type TslNode } from './grime';
import { hullDecal, hullShell, hullTimbers } from './hull';
import { DEPTH, DRAFT, section } from './hull-shape';
import { projectUv } from './kit';
import { JETTIES, QUAY_EDGE, WATER_Y } from './layout';

const BOATS: readonly BoatSpec[] = [
  { x: -28.75, z: 27.5, yaw: Math.PI / 2, length: 5.6, beam: 2.0, hull: 0xe9e4d6, stripe: 0x2f5f86, stern: 'transom', clinker: true, outboard: true, name: 'ROSINA', reg: '3PA 418' },
  { x: -23.2, z: 31.5, yaw: -Math.PI / 2, length: 6.4, beam: 2.2, hull: 0x2f6f8f, stripe: 0xe9e4d6, stern: 'pointed', mast: true, name: 'SAN PIETRO', reg: '3PA 207' },
  { x: 0.1, z: 26.5, yaw: Math.PI / 2, length: 7.4, beam: 2.5, hull: 0xe9e4d6, stripe: 0xa5392f, stern: 'pointed', cabin: true, mast: true, name: 'STELLA MARIS', reg: '3PA 112' },
  { x: 5.75, z: 30, yaw: -Math.PI / 2, length: 5.4, beam: 1.9, hull: 0xd9b55a, stripe: 0x3d6b4a, stern: 'pointed', clinker: true, name: 'LUCIA', reg: '3PA 533' },
  { x: 3.5, z: 39.5, yaw: 0.04, length: 6.8, beam: 2.3, hull: 0x3d6b4a, stripe: 0xe9e4d6, stern: 'pointed', cabin: true, name: 'GABBIANO', reg: '3PA 096' },
  { x: 26.35, z: 28.5, yaw: Math.PI / 2, length: 5.8, beam: 2.0, hull: 0xa5392f, stripe: 0xe9e4d6, stern: 'transom', outboard: true, name: 'NINA', reg: '3PA 381' },
  { x: 31.6, z: 25.5, yaw: -Math.PI / 2, length: 5.2, beam: 1.9, hull: 0xe9e4d6, stripe: 0x3d6b4a, stern: 'pointed', clinker: true, mast: true, name: 'DELFINO', reg: '3PA 264' },
  { x: -38, z: 21.6, yaw: Math.PI, length: 5.6, beam: 2.0, hull: 0x7fa6b8, stripe: 0xe9e4d6, stern: 'pointed', clinker: true, name: 'MARETTA', reg: '3PA 470' },
  // Laid up across the east end of the quay: it screens the players' spawn from the long view down the quay.
  { x: 42.3, z: 14.9, yaw: 1.3, length: 5.6, beam: 2.0, hull: 0x2f5f86, stripe: 0xd9b55a, stern: 'pointed', name: 'ASSUNTA', reg: '3PA 059', ashore: 0.6, covered: true },
];

const CELL_W = 512;
const CELL_H = 96;

/** Lettering mask for every boat: registration in the left column, name in the right. Alpha only; the paint colour comes from the decal. */
function letteringAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W * 2;
  canvas.height = CELL_H * BOATS.length;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Harbor: 2D canvas is not available for the boat lettering');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  BOATS.forEach((spec, i) => {
    const y = i * CELL_H + CELL_H / 2 + 3;
    ctx.font = `bold 70px 'Arial Narrow', Arial, sans-serif`;
    ctx.fillText(spec.reg, CELL_W / 2, y, CELL_W - 30);
    ctx.font = `bold 58px Georgia, 'Times New Roman', serif`;
    ctx.fillText(spec.name, CELL_W * 1.5, y, CELL_W - 30);
  });
  const map = new THREE.CanvasTexture(canvas);
  map.anisotropy = 4;
  return map;
}

/** Atlas rectangle [u0, v0, u1, v1] of a boat's registration (column 0) or name (column 1). */
function cell(index: number, column: 0 | 1): readonly [number, number, number, number] {
  const rows = BOATS.length;
  return [column / 2, 1 - (index + 1) / rows, (column + 1) / 2, 1 - index / rows];
}

const luma = (hex: number): number => {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
};

/**
 * One material for every boat. Fittings take their vertex paint as it is; the
 * planking adds what the sea does to it: antifouling below the waterline, a
 * band of weed and slime along it, rust-brown weeps from the fastenings, salt
 * bloom and patches where the paint has gone to bare wood.
 */
function boatMaterial(assets: Assets, grime: THREE.Texture, lettering: THREE.Texture): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, side: THREE.DoubleSide, alphaTest: 0.5 });
  const planks = assets.pbr('pbr-harbor-blue-planks');
  material.normalMap = planks.normal;
  material.normalScale = new THREE.Vector2(0.6, 0.6);

  const paint: TslNode = attribute('paint', 'vec4');
  const isHull = step(0.5, paint.a).mul(step(paint.a, 1.5));
  const isDecal = step(1.5, paint.a);
  const g = grimeSampler(grime);
  const y = positionLocal.y;
  const coord = vec2(positionLocal.x.add(positionLocal.z.mul(0.6)), y);
  const blotch = g(coord, 1.7).r;
  const fine = g(coord, 0.33).b;
  const drips = g(coord, 1.1, 0.23).g;
  const islands = g(coord, 2.6, 0.41).a;

  const waterline = float(DRAFT).add(blotch.sub(0.5).mul(0.05));
  const below = smoothstep(0.025, -0.02, y.sub(waterline)).mul(isHull);
  const slime = smoothstep(0.17, 0.0, abs(y.sub(waterline).sub(0.03))).mul(mix(float(0.45), float(1), fine)).mul(isHull);
  const weep = smoothstep(0.6, 0.92, drips).mul(smoothstep(0.0, 0.35, y.sub(waterline))).mul(isHull);
  const bare = smoothstep(0.79, 0.82, islands.add(fine.sub(0.5).mul(0.12))).mul(isHull);
  const salt = smoothstep(0.3, 0.05, y.sub(waterline)).mul(smoothstep(0.55, 0.8, fine)).mul(isHull);

  const coat = paint.rgb.mul(mix(float(0.78), float(1.06), fine)).mul(mix(float(0.85), float(1.06), blotch));
  const worn = mix(coat, color(0x6f5d47).mul(mix(float(0.6), float(1.1), fine)), bare.mul(0.85));
  const streaked = mix(worn, worn.mul(color(0x9a6a48)), weep.mul(0.65));
  const antifoul = color(0x5a2a23).mul(mix(float(0.6), float(1.15), fine)).mul(mix(float(0.8), float(1.1), blotch));
  const wetted = mix(mix(streaked, antifoul, below), color(0x39472a), slime.mul(0.7));
  material.colorNode = mix(wetted, color(0xd9d6cb), salt.mul(0.35));
  material.roughnessNode = mix(mix(float(0.62), float(0.9), bare), float(0.28), below.max(slime.mul(0.8)));
  material.opacityNode = mix(float(1), texture(lettering, attribute('duv', 'vec2')).a, isDecal);
  return material;
}

/** Point of the nearest jetty or quay edge to a world position, where a mooring line can be made fast. */
function mooringPoint(x: number, z: number): { x: number; z: number; distance: number } {
  const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v));
  const candidates = [{ x, z: QUAY_EDGE - 0.1 }];
  for (const jetty of JETTIES) {
    const z1 = QUAY_EDGE + jetty.length;
    candidates.push({ x: clamp(x, jetty.x - jetty.width / 2 + 0.1, jetty.x + jetty.width / 2 - 0.1), z: clamp(z, QUAY_EDGE, z1 - 0.1) });
    if (jetty.head > 0) candidates.push({ x: clamp(x, jetty.x - jetty.head + 0.1, jetty.x + jetty.head - 0.1), z: clamp(z, z1 - 2.7, z1 - 0.1) });
  }
  let best = { x, z, distance: Infinity };
  for (const c of candidates) {
    const distance = Math.hypot(c.x - x, c.z - z);
    if (distance < best.distance) best = { ...c, distance };
  }
  return best;
}

function boatGeometry(spec: BoatSpec, index: number, baseY: number, random: () => number): THREE.BufferGeometry {
  const paint = { hull: spec.hull, stripe: spec.stripe };
  const parts = [...hullShell(spec, paint, spec.clinker ?? false), ...hullTimbers(spec, paint)];
  const ink = luma(spec.hull) > 0.35 ? 0x1c2a3c : 0xece6d6;
  for (const side of [1, -1] as const) {
    parts.push(hullDecal(spec, side, 0.7, 0.86, 0.6, 0.8, cell(index, 0), ink));
    parts.push(hullDecal(spec, side, 0.12, 0.3, 0.6, 0.8, cell(index, 1), ink));
  }
  addJoinery(parts, spec);
  if (spec.cabin) addWheelhouse(parts, spec);
  if (spec.outboard) addOutboard(parts, spec);
  if (spec.mast) addMast(parts, spec);
  if (!spec.cabin && !spec.outboard && !spec.covered) addOars(parts, spec);
  const cleats = addFenders(parts, spec);
  addClutter(parts, spec, random);

  // Mooring lines from each cleat to whatever is close enough to tie up to.
  if (spec.ashore === undefined) {
    const cos = Math.cos(spec.yaw);
    const sin = Math.sin(spec.yaw);
    for (const cleat of cleats) {
      const wx = spec.x + cleat[0] * cos + cleat[2] * sin;
      const wz = spec.z - cleat[0] * sin + cleat[2] * cos;
      const fast = mooringPoint(wx, wz);
      if (fast.distance > 3.2 || fast.distance < 0.25) continue;
      const dx = fast.x - spec.x;
      const dz = fast.z - spec.z;
      const end: Point = [dx * cos - dz * sin, 0.06 - baseY, dx * sin + dz * cos];
      parts.push(slackLine(cleat, end, 0.12 + fast.distance * 0.1, 0.014, 0xb09a72));
    }
  }
  return mergeBoat(parts);
}

const TARP_RISE = 1.05;

/** Tarpaulin over a ridge pole, lashed down outside the gunwales. Local boat coordinates. */
function tarpGeometry(spec: BoatSpec): THREE.BufferGeometry {
  const positions: number[] = [];
  const steps = 12;
  const station = (i: number) => {
    const t = 0.03 + (0.94 * i) / steps;
    const shape = section(t, spec);
    // The ridge runs level amidships and drops to the stem and stern posts.
    const ends = Math.pow(Math.abs(2 * t - 1), 3);
    return { x: (t - 0.5) * spec.length, ridge: shape.gunwale + TARP_RISE * (1 - ends) + 0.12, eave: shape.gunwale - 0.16, half: shape.half(1) + 0.07 };
  };
  for (let i = 0; i < steps; i++) {
    const a = station(i);
    const b = station(i + 1);
    for (const side of [-1, 1]) {
      const quad = [
        [a.x, a.ridge, 0],
        [b.x, b.ridge, 0],
        [b.x, b.eave, side * b.half],
        [a.x, a.eave, side * a.half],
      ] as const;
      for (const k of side > 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]) positions.push(...quad[k]!);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  projectUv(geometry, 1.4);
  return geometry;
}

export interface Fleet {
  update(elapsed: number): void;
  dispose(): void;
}

/** Moored fishing boats that rock gently on the water, plus one hauled out on the quay. */
export function addBoats(kit: Kit, root: THREE.Object3D, assets: Assets): Fleet {
  const lettering = letteringAtlas();
  const material = boatMaterial(assets, kit.mats.grime, lettering);

  const afloat: { mesh: THREE.Mesh; phase: number; baseY: number }[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  BOATS.forEach((spec, index) => {
    const baseY = spec.ashore ?? WATER_Y - DRAFT;
    const geometry = boatGeometry(spec, index, baseY, kit.random);
    geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(spec.x, baseY, spec.z);
    mesh.name = 'harbor-boat';
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = spec.yaw;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    if (spec.ashore === undefined) afloat.push({ mesh, phase: kit.random() * Math.PI * 2, baseY });
    else {
      // Heeled over on low chocks, or upright on stocks when it is laid up under cover.
      if (!spec.covered) mesh.rotation.x = 0.16;
      const cos = Math.cos(spec.yaw);
      const sin = Math.sin(spec.yaw);
      for (const t of [-0.28, 0.28]) {
        const cx = spec.x + cos * spec.length * t;
        const cz = spec.z - sin * spec.length * t;
        if (!spec.covered) {
          kit.batch.box(kit.mats.planks, 0.22, 0.34, 1.3, cx, 0.17, cz, { yaw: spec.yaw, tile: 1.5 });
          continue;
        }
        // Cribbing under the keel: baulks laid crosswise, then lengthwise, up to the hull.
        const layers = Math.ceil((baseY + 0.2) / 0.2);
        for (let layer = 0; layer < layers; layer++) {
          const crosswise = layer % 2 === 0;
          for (const offset of [-0.32, 0.32]) {
            const lx = crosswise ? offset : 0;
            const lz = crosswise ? 0 : offset;
            kit.batch.box(kit.mats.planksPale, crosswise ? 0.2 : 0.95, 0.2, crosswise ? 0.95 : 0.2, cx + lx * cos + lz * sin, 0.1 + layer * 0.2, cz - lx * sin + lz * cos, {
              yaw: spec.yaw,
              tile: 1.2,
            });
          }
        }
        // Shores propped against the bilge on both sides.
        for (const side of [-1, 1]) {
          const reach = spec.beam * 0.5 + 0.55;
          kit.batch.box(kit.mats.planksPale, 0.08, 1.55, 0.08, cx + side * sin * reach * 0.78, 0.68, cz + side * cos * reach * 0.78, {
            yaw: spec.yaw,
            pitch: -side * 0.5,
            tile: 1.2,
          });
        }
      }
      if (spec.covered) {
        const tarp = tarpGeometry(spec);
        tarp.rotateY(spec.yaw);
        tarp.translate(spec.x, baseY, spec.z);
        kit.batch.add(kit.mats.tarp, tarp);
      }
    }
    const top = baseY + DEPTH + (spec.covered ? TARP_RISE : 0.15);
    const bottom = Math.min(baseY, WATER_Y - 0.3);
    kit.colliders.box(spec.length * 0.88, top - bottom, spec.beam * 0.82, spec.x, (top + bottom) / 2, spec.z, 'wood', spec.yaw);
  });

  return {
    update: (elapsed) => {
      for (const boat of afloat) {
        boat.mesh.position.y = boat.baseY + Math.sin(elapsed * 0.9 + boat.phase) * 0.03;
        boat.mesh.rotation.x = Math.sin(elapsed * 0.7 + boat.phase * 1.7) * 0.03;
        boat.mesh.rotation.z = Math.sin(elapsed * 0.55 + boat.phase) * 0.012;
      }
    },
    dispose: () => {
      for (const geometry of geometries) geometry.dispose();
      material.dispose();
      lettering.dispose();
    },
  };
}
