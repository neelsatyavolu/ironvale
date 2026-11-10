import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Assets } from '../../core/assets';
import type { Kit } from './facade';
import { projectUv } from './kit';
import { JETTIES, QUAY_EDGE, SEABED_Y, WATER_Y, type Jetty } from './layout';

interface BoatSpec {
  readonly x: number;
  readonly z: number;
  /** Bow points along +X at yaw 0. */
  readonly yaw: number;
  readonly length: number;
  readonly beam: number;
  readonly hull: number;
  readonly stripe: number;
  readonly cabin?: boolean;
  readonly mast?: boolean;
  /** Height of the keel when the boat is ashore; afloat boats leave this unset. */
  readonly ashore?: number;
  /** Laid up under a tarpaulin on a ridge pole: tall enough to hide behind. */
  readonly covered?: boolean;
}

const BOATS: readonly BoatSpec[] = [
  { x: -28.75, z: 27.5, yaw: Math.PI / 2, length: 5.6, beam: 2.0, hull: 0xe9e4d6, stripe: 0x2f5f86 },
  { x: -23.2, z: 31.5, yaw: -Math.PI / 2, length: 6.4, beam: 2.2, hull: 0x2f6f8f, stripe: 0xe9e4d6, mast: true },
  { x: 0.1, z: 26.5, yaw: Math.PI / 2, length: 7.4, beam: 2.5, hull: 0xe9e4d6, stripe: 0xa5392f, cabin: true, mast: true },
  { x: 5.75, z: 30, yaw: -Math.PI / 2, length: 5.4, beam: 1.9, hull: 0xd9b55a, stripe: 0x3d6b4a },
  { x: 3.5, z: 39.5, yaw: 0.04, length: 6.8, beam: 2.3, hull: 0x3d6b4a, stripe: 0xe9e4d6, cabin: true },
  { x: 26.35, z: 28.5, yaw: Math.PI / 2, length: 5.8, beam: 2.0, hull: 0xa5392f, stripe: 0xe9e4d6 },
  { x: 31.6, z: 25.5, yaw: -Math.PI / 2, length: 5.2, beam: 1.9, hull: 0xe9e4d6, stripe: 0x3d6b4a, mast: true },
  { x: -38, z: 21.6, yaw: Math.PI, length: 5.6, beam: 2.0, hull: 0x7fa6b8, stripe: 0xe9e4d6 },
  // Laid up across the east end of the quay: it screens the players' spawn from the long view down the quay.
  { x: 42.3, z: 14.9, yaw: 1.3, length: 5.6, beam: 2.0, hull: 0x2f5f86, stripe: 0xd9b55a, ashore: 0.6, covered: true },
];

const DEPTH = 0.95;
const DRAFT = 0.34;
const STATIONS = 16;
const RING = 7;
const WOOD = 0x8a6f4d;

function tint(geometry: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  const c = new THREE.Color(hex);
  const count = flat.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  flat.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  if (!flat.getAttribute('uv')) projectUv(flat, 1);
  return flat;
}

function part(w: number, h: number, d: number, x: number, y: number, z: number, hex: number, yaw = 0): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(w, h, d);
  projectUv(geometry, 1);
  if (yaw !== 0) geometry.rotateY(yaw);
  geometry.translate(x, y, z);
  return tint(geometry, hex);
}

/** Section shape of a double-ended fishing boat at `t` along its length (0 stern, 1 bow). */
function section(t: number, beam: number) {
  const fullness = Math.max(0.03, Math.pow(Math.sin(Math.PI * t), 0.6));
  const end = Math.abs(2 * t - 1);
  const gunwale = DEPTH + 0.3 * end * end * (t > 0.5 ? 1.5 : 1);
  const keel = 0.34 * end * end * end;
  return {
    gunwale,
    keel,
    half: (s: number) => (beam / 2) * fullness * Math.pow(s, 0.5),
    height: (s: number) => keel + (gunwale - keel) * Math.pow(s, 1.7),
    /** Hull half-width at a given height, 0 below the keel. */
    halfAt: (y: number) => {
      if (y <= keel) return 0;
      const s = Math.pow(Math.min(1, (y - keel) / (gunwale - keel)), 1 / 1.7);
      return (beam / 2) * fullness * Math.pow(s, 0.5);
    },
  };
}

function hullGeometry(spec: BoatSpec): THREE.BufferGeometry {
  const ringCount = RING * 2 + 1;
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let i = 0; i <= STATIONS; i++) {
    const t = i / STATIONS;
    const shape = section(t, spec.beam);
    for (let j = 0; j < ringCount; j++) {
      const side = j < RING ? -1 : 1;
      const s = Math.abs(j - RING) / RING;
      positions.push((t - 0.5) * spec.length, shape.height(s), side * shape.half(s));
      uvs.push(t * spec.length, j * 0.2);
    }
  }
  const indices: number[] = [];
  for (let i = 0; i < STATIONS; i++) {
    for (let j = 0; j < ringCount - 1; j++) {
      const a = i * ringCount + j;
      const b = a + ringCount;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  indexed.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  indexed.setIndex(indices);
  indexed.computeVertexNormals();
  const hull = indexed.toNonIndexed();
  indexed.dispose();

  // Paint by band: antifouling below the waterline, hull colour, then a contrasting top strake.
  const bottom = new THREE.Color(0x5b2a24);
  const body = new THREE.Color(spec.hull);
  const strake = new THREE.Color(spec.stripe);
  const count = hull.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  const quadsPerStation = ringCount - 1;
  for (let v = 0; v < count; v++) {
    const quad = Math.floor(v / 6) % quadsPerStation;
    const s = Math.abs(quad + 0.5 - RING) / RING;
    const c = s < 0.42 ? bottom : s < 0.8 ? body : strake;
    colors[v * 3] = c.r;
    colors[v * 3 + 1] = c.g;
    colors[v * 3 + 2] = c.b;
  }
  hull.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return hull;
}

function boatGeometry(spec: BoatSpec, random: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [hullGeometry(spec)];
  const at = (t: number) => ({ x: (t - 0.5) * spec.length, shape: section(t, spec.beam) });

  // Gunwale cap and bottom boards, station by station.
  for (let i = 1; i < STATIONS - 1; i++) {
    const a = at(i / STATIONS);
    const b = at((i + 1) / STATIONS);
    const length = b.x - a.x;
    for (const side of [-1, 1]) {
      const za = side * a.shape.half(1);
      const zb = side * b.shape.half(1);
      const yaw = -Math.atan2(zb - za, length);
      parts.push(part(Math.hypot(length, zb - za) + 0.02, 0.05, 0.11, (a.x + b.x) / 2, (a.shape.gunwale + b.shape.gunwale) / 2 + 0.02, (za + zb) / 2, spec.stripe, yaw));
    }
    const floorY = DEPTH * 0.34;
    const width = Math.min(a.shape.halfAt(floorY), b.shape.halfAt(floorY)) * 2 - 0.04;
    if (width > 0.2) parts.push(part(length + 0.01, 0.03, width, (a.x + b.x) / 2, floorY, 0, WOOD));
  }
  // Thwarts.
  for (const t of spec.cabin ? [0.22, 0.74] : [0.28, 0.5, 0.72]) {
    const { x, shape } = at(t);
    const y = DEPTH * 0.7;
    parts.push(part(0.26, 0.045, shape.halfAt(y) * 2 - 0.03, x, y, 0, WOOD));
  }
  // Stem and stern posts.
  for (const t of [0.012, 0.988]) {
    const { x, shape } = at(t);
    parts.push(part(0.1, 0.5, 0.09, x, shape.gunwale - 0.08, 0, spec.stripe));
  }
  if (spec.cabin) {
    const { x } = at(0.44);
    const w = spec.beam * 0.5;
    parts.push(part(1.5, 1.25, w, x, DEPTH + 0.5, 0, 0xe9e4d6));
    parts.push(part(1.7, 0.06, w + 0.2, x, DEPTH + 1.15, 0, spec.stripe));
    parts.push(part(0.04, 0.42, w - 0.2, x + 0.75, DEPTH + 0.8, 0, 0x16202a));
    for (const side of [-1, 1]) parts.push(part(0.9, 0.38, 0.04, x, DEPTH + 0.8, (side * w) / 2, 0x16202a));
  }
  if (spec.mast) {
    const { x } = at(spec.cabin ? 0.68 : 0.6);
    const mast = new THREE.CylinderGeometry(0.035, 0.05, 3.4, 8);
    mast.translate(x, DEPTH * 0.34 + 1.7, 0);
    parts.push(tint(mast, WOOD));
    parts.push(part(1.9, 0.05, 0.05, x - 0.8, DEPTH + 1.0, 0, WOOD));
  }
  // Working clutter: fish boxes, a heap of net, floats and fenders.
  const boxes = 1 + Math.floor(random() * 3);
  for (let i = 0; i < boxes; i++) {
    const { x } = at(0.3 + random() * 0.12 + (spec.cabin ? 0.42 : 0.25 * i));
    parts.push(part(0.6, 0.24, 0.4, x, DEPTH * 0.34 + 0.135 + (i % 2) * 0.24, (random() - 0.5) * 0.3, [0x2f5f86, 0xc9d2d6, 0xb5483a][i % 3]!, random() * 0.6));
  }
  const heap = new THREE.IcosahedronGeometry(0.42, 1);
  heap.scale(1.3, 0.42, 1);
  heap.translate(at(0.16).x + 0.3, DEPTH * 0.34 + 0.16, 0);
  parts.push(tint(heap, 0x35564d));
  for (let i = 0; i < 4; i++) {
    const ball = new THREE.SphereGeometry(0.09, 8, 6);
    ball.translate(at(0.16).x + 0.1 + random() * 0.5, DEPTH * 0.34 + 0.36, (random() - 0.5) * 0.5);
    parts.push(tint(ball, 0xd4622a));
  }
  for (const [t, side] of [
    [0.36, 1],
    [0.62, 1],
    [0.4, -1],
    [0.66, -1],
  ] as const) {
    const { x, shape } = at(t);
    const fender = new THREE.CylinderGeometry(0.085, 0.085, 0.42, 8);
    fender.translate(x, shape.gunwale - 0.3, side * (shape.half(1) + 0.07));
    parts.push(tint(fender, 0xd8d6cf));
  }
  const merged = mergeGeometries(parts, false);
  for (const geometry of parts) geometry.dispose();
  if (!merged) throw new Error('Harbor: could not merge boat geometry');
  return merged;
}

const TARP_RISE = 1.05;

/** Tarpaulin over a ridge pole, lashed down outside the gunwales. Local boat coordinates. */
function tarpGeometry(spec: BoatSpec): THREE.BufferGeometry {
  const positions: number[] = [];
  const steps = 12;
  const station = (i: number) => {
    const t = 0.03 + (0.94 * i) / steps;
    const shape = section(t, spec.beam);
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
  const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide });
  const planks = assets.pbr('pbr-harbor-blue-planks');
  material.normalMap = planks.normal;
  material.normalScale = new THREE.Vector2(0.7, 0.7);

  const afloat: { mesh: THREE.Mesh; phase: number; baseY: number }[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  for (const spec of BOATS) {
    const geometry = boatGeometry(spec, kit.random);
    geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    const baseY = spec.ashore ?? WATER_Y - DRAFT;
    mesh.position.set(spec.x, baseY, spec.z);
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
  }

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
    },
  };
}

/** Timber jetties on piles, flush with the quay. */
export function addJetties(kit: Kit): void {
  for (const jetty of JETTIES) addJetty(kit, jetty);
}

function addJetty(kit: Kit, jetty: Jetty): void {
  const { batch, colliders, mats } = kit;
  const x0 = jetty.x - jetty.width / 2;
  const x1 = jetty.x + jetty.width / 2;
  const z0 = QUAY_EDGE + 0.06;
  const z1 = QUAY_EDGE + jetty.length;
  const deck = (ax: number, bx: number, az: number, bz: number): void => {
    batch.span(mats.planksPale, ax, bx, -0.07, 0, az, bz, { tile: 1.5, swap: true });
    batch.span(mats.planks, ax + 0.12, ax + 0.3, -0.3, -0.07, az, bz, { tile: 1.5 });
    batch.span(mats.planks, bx - 0.3, bx - 0.12, -0.3, -0.07, az, bz, { tile: 1.5 });
    colliders.span(ax, bx, -0.34, 0, az, bz, 'wood');
  };
  deck(x0, x1, z0, z1);
  if (jetty.head > 0) {
    deck(jetty.x - jetty.head, x0, z1 - 2.8, z1);
    deck(x1, jetty.x + jetty.head, z1 - 2.8, z1);
  }

  const pile = (x: number, z: number, tall: boolean): void => {
    const top = tall ? 0.85 + kit.random() * 0.25 : 0.04;
    const bottom = SEABED_Y - 0.3;
    const geometry = new THREE.CylinderGeometry(0.12, 0.14, top - bottom, 10);
    batch.place(mats.planks, geometry, x, (top + bottom) / 2, z, kit.random() * 3);
    geometry.dispose();
    if (tall) colliders.box(0.26, top, 0.26, x, top / 2, z, 'wood');
  };
  const bays = Math.max(2, Math.round((z1 - z0) / 3.2));
  for (let i = 1; i <= bays; i++) {
    const z = z0 + ((z1 - z0) * i) / bays - 0.25;
    const tall = i % 2 === 0;
    pile(x0 - 0.1, z, tall);
    pile(x1 + 0.1, z, tall && i !== bays);
    batch.span(mats.planks, x0 - 0.2, x1 + 0.2, -0.46, -0.3, z - 0.08, z + 0.08, { tile: 1.5, swap: true });
  }
  if (jetty.head > 0) {
    for (const x of [jetty.x - jetty.head + 0.1, jetty.x + jetty.head - 0.1]) {
      pile(x, z1 - 0.2, true);
      pile(x, z1 - 2.6, false);
    }
  }
}
