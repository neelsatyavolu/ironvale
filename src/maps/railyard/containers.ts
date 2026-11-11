import * as THREE from 'three/webgpu';
import { instancedBufferAttribute } from 'three/tsl';
import { MeshBuilder } from './builder';
import type { Kit } from './kit';
import { logoGeometry, type LogoText, type Materials } from './materials';
import { CONTAINER, LIGHT_LIVERY_FROM, LIVERIES, type ContainerSpot } from './plan';

const POST = 0.16;
const BOTTOM_RAIL = 0.16;
const TOP_RAIL = 0.11;
const RIB_DEPTH = 0.036;
const RIB_PITCH = 0.278;
/** Real-world size of one repeat of the container paint texture. */
const PAINT_TILE = 1.94;
const SHIPPING_LINES: readonly LogoText[] = ['NORDHAVN', 'KESTREL LINE', 'HALCYON', 'TERNMARK'];
const SERIALS: readonly LogoText[] = ['NHVU 482913 7', 'KSTU 305518 2', 'TRNU 771264 0'];
const LIGHT_INK = 0xdedbd2;
const DARK_INK = 0x1d2b3c;

/**
 * Trapezoidal corrugated sheet in the XY plane, `length` along X, facing +Z.
 * The crests sit at z = 0 and the troughs at z = -depth.
 */
export function corrugatedPanel(length: number, height: number, depth: number, pitch: number, tile: number): THREE.BufferGeometry {
  const ribs = Math.max(1, Math.round(length / pitch));
  const step = length / ribs;
  // One rib: crest, slope down, trough, slope up. Quarter of the pitch each.
  const profile: [number, number][] = [];
  for (let i = 0; i < ribs; i++) {
    const x = -length / 2 + i * step;
    profile.push([x, 0], [x + step * 0.3, 0], [x + step * 0.5, -depth], [x + step * 0.8, -depth]);
  }
  profile.push([length / 2, 0]);

  const position: number[] = [];
  const normal: number[] = [];
  const uv: number[] = [];
  for (let i = 0; i < profile.length - 1; i++) {
    const [x0, z0] = profile[i] as [number, number];
    const [x1, z1] = profile[i + 1] as [number, number];
    const run = Math.hypot(x1 - x0, z1 - z0);
    const nx = -(z1 - z0) / run;
    const nz = (x1 - x0) / run;
    const corners: [number, number, number][] = [
      [x0, 0, z0],
      [x1, 0, z1],
      [x1, height, z1],
      [x0, 0, z0],
      [x1, height, z1],
      [x0, height, z0],
    ];
    for (const [x, y, z] of corners) {
      position.push(x, y, z);
      normal.push(nx, 0, nz);
      uv.push(x / tile, y / tile);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geometry;
}

/**
 * One ISO container: corner posts, rails, corner castings, corrugated sides
 * and front, and a pair of doors with locking bars at +Z. Origin at the centre
 * of the underside, long axis on Z.
 */
export function containerGeometry(length: number): THREE.BufferGeometry {
  const { width, height } = CONTAINER;
  const builder = new MeshBuilder();
  const halfW = width / 2;
  const halfL = length / 2;

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      builder.box(POST, height, POST, sx * (halfW - POST / 2), height / 2, sz * (halfL - POST / 2));
      for (const y of [0.06, height - 0.06]) {
        builder.box(0.19, 0.125, 0.19, sx * (halfW - 0.085), y, sz * (halfL - 0.085));
      }
    }
    builder.box(0.1, BOTTOM_RAIL, length, sx * (halfW - 0.05), BOTTOM_RAIL / 2, 0);
    builder.box(0.07, TOP_RAIL, length, sx * (halfW - 0.035), height - TOP_RAIL / 2, 0);
  }
  for (const sz of [-1, 1]) {
    builder.box(width, BOTTOM_RAIL, 0.12, 0, BOTTOM_RAIL / 2, sz * (halfL - 0.06));
    builder.box(width, TOP_RAIL + 0.03, 0.12, 0, height - (TOP_RAIL + 0.03) / 2, sz * (halfL - 0.06));
  }
  builder.box(width - 0.1, 0.03, length - 0.1, 0, height - 0.05, 0);
  builder.box(width - 0.1, 0.04, length - 0.1, 0, 0.13, 0);

  const panelHeight = height - BOTTOM_RAIL - TOP_RAIL;
  const side = corrugatedPanel(length - POST * 2, panelHeight, RIB_DEPTH, RIB_PITCH, PAINT_TILE);
  for (const sx of [-1, 1]) {
    const matrix = new THREE.Matrix4().makeRotationY((sx * Math.PI) / 2).setPosition(sx * (halfW - 0.02), BOTTOM_RAIL, 0);
    builder.add(side, matrix);
  }
  side.dispose();
  const front = corrugatedPanel(width - POST * 2, panelHeight, RIB_DEPTH, RIB_PITCH, PAINT_TILE);
  builder.add(front, new THREE.Matrix4().makeRotationY(Math.PI).setPosition(0, BOTTOM_RAIL, -(halfL - 0.03)));
  front.dispose();

  // Doors: two leaves, each with two locking bars, cam keepers and a handle.
  const doorZ = halfL - 0.045;
  const leaf = (width - POST * 2) / 2 - 0.01;
  for (const sx of [-1, 1]) {
    const cx = sx * (leaf / 2 + 0.005);
    builder.box(leaf, panelHeight, 0.04, cx, BOTTOM_RAIL + panelHeight / 2, doorZ);
    for (const y of [0.55, 1.3, 2.05]) builder.box(leaf - 0.06, 0.05, 0.03, cx, y, doorZ + 0.025);
    for (const offset of [-0.25, 0.22]) {
      const barX = cx + offset;
      builder.box(0.034, panelHeight + 0.14, 0.034, barX, height / 2, doorZ + 0.055);
      for (const y of [0.14, height - 0.14]) builder.box(0.09, 0.07, 0.06, barX, y, doorZ + 0.05);
      builder.box(0.3, 0.03, 0.02, barX + 0.13, 1.05 + offset * 0.3, doorZ + 0.075);
      builder.box(0.06, 0.09, 0.03, barX + 0.27, 1.05 + offset * 0.3, doorZ + 0.07);
    }
    for (const y of [0.4, 1.0, 1.6, 2.2]) builder.box(0.05, 0.12, 0.05, sx * (halfW - POST - 0.01), y, doorZ + 0.03);
  }
  return builder.build();
}

/** Places every container as instances, with one box collider per stack and lettering on some sides. */
export function buildContainers(kit: Kit, materials: Materials, spots: readonly ContainerSpot[]): void {
  const prototypes = {
    short: kit.own(containerGeometry(CONTAINER.length20)),
    long: kit.own(containerGeometry(CONTAINER.length40)),
  };
  // Scenery beyond the fence is drawn separately so it can skip the shadow pass.
  const groups = {
    short: { geometry: prototypes.short, matrices: [] as THREE.Matrix4[], colors: [] as THREE.Color[], cast: true },
    long: { geometry: prototypes.long, matrices: [] as THREE.Matrix4[], colors: [] as THREE.Color[], cast: true },
    backdrop: { geometry: prototypes.short, matrices: [] as THREE.Matrix4[], colors: [] as THREE.Color[], cast: false },
  };
  const logos = new Map<LogoText, THREE.BufferGeometry>(SHIPPING_LINES.map((name) => [name, logoGeometry(name, 3.4)]));
  // Owner code and serial on both sides and the right-hand door, a weights line and the data plate.
  const serials = SERIALS.map((text) => ({ side: logoGeometry(text, 1.15), door: logoGeometry(text, 0.42) }));
  const weights = { side: logoGeometry('MAX GR 30480 KG', 0.8), door: logoGeometry('MAX GR 30480 KG', 0.4) };
  const plate = new THREE.BoxGeometry(0.2, 0.26, 0.006);

  spots.forEach((spot, index) => {
    // Backdrop stacks thin out from the top at lower detail; the decision uses the index, not the random stream.
    const keep = !spot.backdrop || spot.stackBase || (index % 20) / 20 < kit.detail;
    const shade = kit.range(0.82, 1.08);
    const line = kit.pick(SHIPPING_LINES);
    if (!keep) return;

    const group = spot.backdrop ? groups.backdrop : spot.long ? groups.long : groups.short;
    const length = spot.long ? CONTAINER.length40 : CONTAINER.length20;
    group.matrices.push(kit.transform(spot.x, spot.y, spot.z, spot.yaw));
    group.colors.push(new THREE.Color(LIVERIES[spot.livery]).multiplyScalar(shade));

    if (spot.stackBase && !spot.backdrop) {
      kit.collide(CONTAINER.width, CONTAINER.height * spot.stackLevels, length, spot.x, spot.y, spot.z, 'metal', spot.yaw);
    }
    if (spot.backdrop) return;
    const ink = spot.livery >= LIGHT_LIVERY_FROM ? DARK_INK : LIGHT_INK;
    const base = kit.transform(spot.x, spot.y, spot.z, spot.yaw);
    const mark = (geometry: THREE.BufferGeometry, turn: number, lx: number, ly: number, lz: number): void => {
      kit.add(materials.lettering, geometry, base.clone().multiply(new THREE.Matrix4().makeRotationY(turn).setPosition(lx, ly, lz)), ink);
    };
    const serial = serials[index % serials.length] as (typeof serials)[number];
    for (const sx of [-1, 1]) {
      const face = sx * (CONTAINER.width / 2 - 0.012);
      const turn = (sx * Math.PI) / 2;
      if (spot.lettered) mark(logos.get(line) as THREE.BufferGeometry, turn, face, 1.86, sx * (length / 2 - 2.4));
      // Top right corner as you face each side.
      mark(serial.side, turn, face, 2.3, -sx * (length / 2 - 0.95));
      mark(weights.side, turn, face, 2.12, -sx * (length / 2 - 0.78));
    }
    const doorZ = length / 2 - 0.02;
    mark(serial.door, 0, 0.57, 2.28, doorZ);
    mark(weights.door, 0, 0.57, 2.19, doorZ);
    kit.add(materials.steel, plate, base.clone().multiply(new THREE.Matrix4().makeTranslation(-0.57, 1.0, doorZ)), 0x9a9d9c);
  });

  for (const geometry of [...logos.values(), ...serials.flatMap((entry) => [entry.side, entry.door]), weights.side, weights.door, plate]) geometry.dispose();
  for (const group of Object.values(groups)) {
    if (group.matrices.length === 0) continue;
    // The livery goes in as its own instanced attribute, so rust and dirt are not tinted by it.
    const liveries = new THREE.InstancedBufferAttribute(new Float32Array(group.colors.flatMap((color) => [color.r, color.g, color.b])), 3);
    const material = materials.containerPaint(instancedBufferAttribute(liveries));
    kit.instances(group.geometry, material, group.matrices, undefined, { cast: group.cast, receive: true });
  }
}
