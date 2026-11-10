import * as THREE from 'three/webgpu';
import { addBalcony, addDoor, addWindow, Frame, PLASTER_TILE, WALL_THICKNESS, type Kit, type ShutterState, type Side } from './facade';
import { projectUv } from './kit';
import { STOREY } from './layout';
import { bayCentres, wallPieces, type Rect } from './pieces';

/** `open` is a real hole to walk through; `door` and `window` are filled; `shut` is a shuttered blind window. */
export type OpeningKind = 'open' | 'door' | 'window' | 'french' | 'shut';

export interface GroundOpening {
  /** Centre along the wall from its west or north end. */
  readonly u: number;
  readonly w: number;
  readonly h: number;
  readonly kind: OpeningKind;
  /** Height of the bottom edge above the floor; 0 for doors. */
  readonly sill?: number;
}

export interface HouseSpec {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
  readonly base?: number;
  readonly storeys: number;
  readonly storeyHeight?: number;
  /** Index into the plaster palette. */
  readonly wall: number;
  /** Index into the paint palette, for shutters and doors. */
  readonly paint: number;
  /** Sides that face the playable area and get windows and doors. */
  readonly detail: readonly Side[];
  readonly ridge?: 'x' | 'z';
  /** Ground-floor openings set by hand; other storeys are generated. */
  readonly ground?: Partial<Record<Side, readonly GroundOpening[]>>;
  /** Enterable ground floor: walls collide piece by piece instead of as one block. */
  readonly hollow?: boolean;
  /** Storeys hidden behind higher ground on a side. */
  readonly buried?: Partial<Record<Side, number>>;
  /** Chance that an upper window becomes a balcony door. */
  readonly balconies?: number;
  readonly trim?: boolean;
  /** false when the caller registers its own colliders (or the building is out of reach). */
  readonly collide?: boolean;
}

export interface Footprint {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
}

interface Opening extends Rect {
  readonly kind: OpeningKind;
}

const ROOF_PITCH = 0.4;
const EAVE = 0.45;
const VERGE = 0.25;
const SIDES: readonly Side[] = ['n', 's', 'e', 'w'];

export interface HouseInfo {
  readonly wallTop: number;
  readonly ridgeY: number;
}

/** Plaster house with generated windows, shutters, balconies and a tiled gable roof. */
export function addHouse(kit: Kit, spec: HouseSpec): HouseInfo {
  const { batch, colliders, mats, random } = kit;
  const base = spec.base ?? 0;
  const storeyHeight = spec.storeyHeight ?? STOREY;
  const height = spec.storeys * storeyHeight + 0.35;
  const plaster = mats.plaster[spec.wall % mats.plaster.length]!;
  const paint = mats.paint[spec.paint % mats.paint.length]!;
  const wallTop = base + height;

  for (const side of SIDES) {
    const alongX = side === 'n' || side === 's';
    const length = alongX ? spec.x1 - spec.x0 : spec.z1 - spec.z0;
    const frame = new Frame(batch, side, side === 'e' ? spec.x1 : spec.x0, side === 's' ? spec.z1 : spec.z0, base);
    const openings = spec.detail.includes(side) ? planOpenings(spec, side, length, storeyHeight, random) : [];

    for (const piece of wallPieces(length, height, openings)) {
      frame.box(plaster, piece.u0, piece.u1, piece.v0, piece.v1, -WALL_THICKNESS, 0, { tile: PLASTER_TILE });
      if (spec.hollow) {
        frame.collide(colliders, piece.u0, piece.u1, piece.v0, piece.v1, -WALL_THICKNESS, 0, 'plaster');
        // Dim lining on the room side of the ground floor.
        if (piece.v0 < storeyHeight) {
          frame.box(mats.plasterShade, piece.u0, piece.u1, piece.v0, Math.min(piece.v1, storeyHeight), -WALL_THICKNESS - 0.03, -WALL_THICKNESS, { tile: PLASTER_TILE });
        }
      }
    }
    if (!spec.detail.includes(side)) continue;

    for (const opening of openings) {
      if (opening.kind === 'open') continue;
      if (opening.kind === 'door') addDoor(kit, frame, opening, paint);
      else {
        const shutters: ShutterState = opening.kind === 'shut' ? 'closed' : pickShutters(random);
        addWindow(
          kit,
          frame,
          opening,
          {
            lit: shutters !== 'closed' && random() < 0.16,
            shutters,
            paint,
            trim: spec.trim ?? false,
            french: opening.kind === 'french',
            flowers: opening.kind === 'window' && shutters !== 'closed' && random() < 0.22,
          },
          random,
        );
        if (opening.kind === 'french' && opening.v0 > 1) addBalcony(kit, frame, (opening.u0 + opening.u1) / 2, opening.v0 - 0.04, random);
      }
      if (spec.hollow) {
        const surface = opening.kind === 'door' || opening.kind === 'shut' ? 'wood' : 'glass';
        frame.collide(colliders, opening.u0, opening.u1, opening.v0, opening.v1, -0.22, -0.1, surface);
      }
    }

    // Stone plinth, broken at doorways, and a cornice under the eaves.
    const ground = (spec.buried?.[side] ?? 0) * storeyHeight;
    const doorways = openings
      .filter((o) => o.v0 < ground + 0.3 && o.v1 > ground)
      .map((o) => ({ u0: o.u0 - 0.15, u1: o.u1 + 0.15, v0: 0, v1: 1 }));
    for (const piece of wallPieces(length, 0.55, doorways)) {
      frame.box(mats.stone, piece.u0, piece.u1, ground, ground + 0.55, 0, 0.05, { tile: 2 });
    }
    frame.box(mats.stoneLight, -0.08, length + 0.08, height - 0.24, height - 0.04, 0, 0.1, { tile: 1.5 });
    // Rainwater pipe near one corner.
    if (random() < 0.6) {
      const u = random() < 0.5 ? 0.22 : length - 0.22;
      frame.box(mats.iron, u - 0.045, u + 0.045, ground + 0.1, height - 0.24, 0.03, 0.12);
      for (let v = ground + 0.9; v < height - 0.5; v += 2.1) frame.box(mats.iron, u - 0.07, u + 0.07, v, v + 0.05, 0, 0.13);
    }
    if (spec.trim) {
      for (let storey = (spec.buried?.[side] ?? 0) + 1; storey < spec.storeys; storey++) {
        const v = storey * storeyHeight - 0.2;
        frame.box(mats.stoneLight, 0, length, v, v + 0.1, 0, 0.035, { tile: 1.5 });
      }
    }
  }

  const ridge = spec.ridge ?? (spec.x1 - spec.x0 >= spec.z1 - spec.z0 ? 'x' : 'z');
  const ridgeY = addGableRoof(kit, spec, wallTop, ridge, plaster);
  if (spec.collide === false) return { wallTop, ridgeY };
  if (!spec.hollow) colliders.span(spec.x0, spec.x1, base, wallTop, spec.z0, spec.z1, 'plaster');
  else colliders.span(spec.x0, spec.x1, base + storeyHeight, wallTop, spec.z0, spec.z1, 'plaster');
  return { wallTop, ridgeY };
}

function pickShutters(random: () => number): ShutterState {
  const roll = random();
  if (roll < 0.46) return 'open';
  if (roll < 0.78) return 'closed';
  return 'ajar';
}

function planOpenings(spec: HouseSpec, side: Side, length: number, storeyHeight: number, random: () => number): Opening[] {
  const openings: Opening[] = [];
  const first = spec.buried?.[side] ?? 0;
  const centres = bayCentres(length, 3.1);
  const manual = spec.ground?.[side];
  const doorBay = Math.floor(random() * centres.length);

  for (let storey = first; storey < spec.storeys; storey++) {
    const floor = storey * storeyHeight;
    if (storey === first && manual) {
      for (const o of manual) {
        const v0 = floor + (o.sill ?? 0);
        openings.push({ u0: o.u - o.w / 2, u1: o.u + o.w / 2, v0, v1: v0 + o.h, kind: o.kind });
      }
      continue;
    }
    centres.forEach((centre, bay) => {
      if (storey === first) {
        if (bay === doorBay && length > 4) {
          const w = 0.95 + Math.floor(random() * 2) * 0.15;
          openings.push({ u0: centre - w / 2, u1: centre + w / 2, v0: floor, v1: floor + 2.12, kind: 'door' });
        } else if (random() < 0.8) {
          openings.push({ u0: centre - 0.45, u1: centre + 0.45, v0: floor + 1.05, v1: floor + 2.25, kind: random() < 0.25 ? 'shut' : 'window' });
        }
        return;
      }
      if (random() < 0.07) return;
      const top = storey === spec.storeys - 1 && spec.storeys > 2;
      if (!top && random() < (spec.balconies ?? 0)) {
        openings.push({ u0: centre - 0.55, u1: centre + 0.55, v0: floor + 0.04, v1: floor + 2.24, kind: 'french' });
      } else {
        const h = top ? 1.2 : 1.5;
        openings.push({ u0: centre - 0.5, u1: centre + 0.5, v0: floor + 0.92, v1: floor + 0.92 + h, kind: 'window' });
      }
    });
  }
  return openings;
}

function triangle(a: readonly [number, number, number], b: readonly [number, number, number], c: readonly [number, number, number]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...a, ...b, ...c]), 3));
  geometry.computeVertexNormals();
  projectUv(geometry, PLASTER_TILE);
  return geometry;
}

/** Two tiled slopes, a ridge cap, the gable walls, a chimney and a roof collider. Returns the ridge height. */
export function addGableRoof(kit: Kit, spec: Footprint, wallTop: number, ridge: 'x' | 'z', plaster: THREE.Material): number {
  const { batch, colliders, mats, random } = kit;
  const { x0, x1, z0, z1 } = spec;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const span = ridge === 'x' ? z1 - z0 : x1 - x0;
  const run = ridge === 'x' ? x1 - x0 : z1 - z0;
  const tan = Math.tan(ROOF_PITCH);
  const half = span / 2 + EAVE;
  const ridgeY = wallTop + (span / 2) * tan;
  const eaveY = wallTop - EAVE * tan;
  const slope = half / Math.cos(ROOF_PITCH);
  const midY = (eaveY + ridgeY) / 2 + 0.07;
  const length = run + VERGE * 2;

  if (ridge === 'x') {
    batch.box(mats.roof, length, 0.13, slope, cx, midY, cz + half / 2, { pitch: ROOF_PITCH, tile: 2.5 });
    batch.box(mats.roof, length, 0.13, slope, cx, midY, cz - half / 2, { pitch: -ROOF_PITCH, tile: 2.5 });
    batch.box(mats.roof, length, 0.1, 0.34, cx, ridgeY + 0.1, cz, { tile: 2.5 });
    batch.add(plaster, triangle([x1, wallTop, z1], [x1, wallTop, z0], [x1, ridgeY, cz]));
    batch.add(plaster, triangle([x0, wallTop, z0], [x0, wallTop, z1], [x0, ridgeY, cz]));
    colliders.span(x0, x1, wallTop, (wallTop + ridgeY) / 2, cz - span / 4, cz + span / 4, 'concrete');
  } else {
    batch.box(mats.roof, slope, 0.13, length, cx + half / 2, midY, cz, { roll: -ROOF_PITCH, tile: 2.5, swap: true });
    batch.box(mats.roof, slope, 0.13, length, cx - half / 2, midY, cz, { roll: ROOF_PITCH, tile: 2.5, swap: true });
    batch.box(mats.roof, 0.34, 0.1, length, cx, ridgeY + 0.1, cz, { tile: 2.5 });
    batch.add(plaster, triangle([x0, wallTop, z1], [x1, wallTop, z1], [cx, ridgeY, z1]));
    batch.add(plaster, triangle([x1, wallTop, z0], [x0, wallTop, z0], [cx, ridgeY, z0]));
    colliders.span(cx - span / 4, cx + span / 4, wallTop, (wallTop + ridgeY) / 2, z0, z1, 'concrete');
  }

  // Chimney part-way down one slope.
  const t = 0.2 + random() * 0.6;
  const offset = (random() < 0.5 ? -1 : 1) * span * 0.22;
  const px = ridge === 'x' ? x0 + run * t : cx + offset;
  const pz = ridge === 'x' ? cz + offset : z0 + run * t;
  const top = ridgeY + 0.55 + random() * 0.4;
  batch.span(plaster, px - 0.3, px + 0.3, wallTop, top, pz - 0.3, pz + 0.3, { tile: PLASTER_TILE });
  batch.span(mats.stoneLight, px - 0.38, px + 0.38, top, top + 0.08, pz - 0.38, pz + 0.38, { tile: 1.5 });
  batch.span(mats.roof, px - 0.24, px + 0.24, top + 0.08, top + 0.3, pz - 0.24, pz + 0.24, { tile: 2.5 });

  // Television aerial on some ridges: a mast and a comb of elements.
  if (random() < 0.4) {
    const ax = ridge === 'x' ? x0 + run * (0.15 + random() * 0.7) : cx;
    const az = ridge === 'x' ? cz : z0 + run * (0.15 + random() * 0.7);
    const mast = 1.5 + random() * 0.9;
    batch.box(mats.iron, 0.03, mast, 0.03, ax, ridgeY + mast / 2, az);
    const yaw = random() * Math.PI;
    batch.box(mats.iron, 0.9, 0.02, 0.02, ax, ridgeY + mast - 0.1, az, { yaw });
    for (let i = 0; i < 5; i++) {
      const along = -0.4 + i * 0.2;
      batch.box(mats.iron, 0.015, 0.015, 0.5 - i * 0.05, ax + Math.cos(yaw) * along, ridgeY + mast - 0.1, az - Math.sin(yaw) * along, { yaw });
    }
  }
  return ridgeY;
}
