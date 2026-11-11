/**
 * Geometry builders for the parts of the M24 that are made in code: lathe-turned
 * profiles, chamfered blocks and knurled rings. Every geometry is non-indexed
 * with `position`, `normal`, `uv` and a `wear` attribute (1 on the chamfers,
 * where the finish rubs through; the worn-black material reads it), so any
 * mix of them merges into one mesh.
 */
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type Vec3 = readonly [number, number, number];
/** Distance along the axis, radius, and whether shading runs smoothly through the point. */
export type ProfilePoint = readonly [z: number, r: number, smooth?: boolean];

export interface TurnedOptions {
  /** Steps around the axis. */
  readonly segments?: number;
  /** Width of the bevel cut on every outside corner; 0 leaves them sharp. */
  readonly chamfer?: number;
  /** Flat faces around the axis, for hexagons. */
  readonly faceted?: boolean;
}

const DEFAULT_CHAMFER = 0.0005;
const STRAIGHT = 0.94;
const AXIS = 1e-7;
const FORWARD = new THREE.Vector3(0, 0, 1);

class Soup {
  private readonly position: number[] = [];
  private readonly normal: number[] = [];
  private readonly uv: number[] = [];
  private readonly wear: number[] = [];

  vertex(p: Vec3, n: Vec3, u: number, v: number, wear: number): void {
    this.position.push(...p);
    this.normal.push(...n);
    this.uv.push(u, v);
    this.wear.push(wear);
  }

  /** A flat convex polygon, wound so it faces away from `inside`. */
  polygon(points: readonly THREE.Vector3[], inside: THREE.Vector3, wear: number): void {
    const normal = new THREE.Vector3().crossVectors(points[1].clone().sub(points[0]), points[2].clone().sub(points[0])).normalize();
    const flip = normal.dot(points[0].clone().sub(inside)) < 0;
    if (flip) normal.negate();
    const n: Vec3 = [normal.x, normal.y, normal.z];
    for (let i = 1; i < points.length - 1; i++) {
      const corners = flip ? [points[0], points[i + 1], points[i]] : [points[0], points[i], points[i + 1]];
      for (const corner of corners) this.vertex([corner.x, corner.y, corner.z], n, 0, 0, wear);
    }
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.position, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normal, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geometry.setAttribute('wear', new THREE.Float32BufferAttribute(this.wear, 1));
    return geometry;
  }
}

interface Station {
  readonly z: number;
  readonly r: number;
  readonly smooth: boolean;
  /** The segment that starts here is a chamfer. */
  readonly worn: boolean;
}

/** Cuts a small bevel on every outside corner of the profile. */
function bevel(profile: readonly ProfilePoint[], chamfer: number): Station[] {
  const stations: Station[] = [];
  profile.forEach(([z, r, smooth = false], index) => {
    const before = profile[index - 1];
    const after = profile[index + 1];
    if (chamfer <= 0 || smooth || !before || !after || r < AXIS) {
      stations.push({ z, r, smooth, worn: false });
      return;
    }
    const lengthIn = Math.hypot(z - before[0], r - before[1]);
    const lengthOut = Math.hypot(after[0] - z, after[1] - r);
    if (lengthIn < 1e-9 || lengthOut < 1e-9) {
      stations.push({ z, r, smooth, worn: false });
      return;
    }
    const inward = [(z - before[0]) / lengthIn, (r - before[1]) / lengthIn];
    const outward = [(after[0] - z) / lengthOut, (after[1] - r) / lengthOut];
    const straight = inward[0] * outward[0] + inward[1] * outward[1] > STRAIGHT;
    // The surface is on the left of the direction of travel, so an outside corner turns right.
    const outside = inward[0] * outward[1] - inward[1] * outward[0] < 0;
    if (straight || !outside) {
      stations.push({ z, r, smooth, worn: false });
      return;
    }
    const cut = Math.min(chamfer, lengthIn * 0.3, lengthOut * 0.3);
    stations.push({ z: z - inward[0] * cut, r: r - inward[1] * cut, smooth: false, worn: true });
    stations.push({ z: z + outward[0] * cut, r: r + outward[1] * cut, smooth: false, worn: false });
  });
  return stations;
}

/**
 * A solid of revolution about +Z. Walk the profile with the surface on your
 * left: toward +Z along an outside wall, toward -Z along a bore. A profile
 * that starts or ends on the axis is closed there.
 */
export function turned(profile: readonly ProfilePoint[], options: TurnedOptions = {}): THREE.BufferGeometry {
  const segments = options.segments ?? 32;
  const stations = bevel(profile, options.chamfer ?? DEFAULT_CHAMFER);
  const spans = stations.slice(0, -1).map((a, index) => {
    const b = stations[index + 1];
    const length = Math.hypot(b.z - a.z, b.r - a.r);
    return { a, b, length, nz: length > 0 ? -(b.r - a.r) / length : 0, nr: length > 0 ? (b.z - a.z) / length : 0 };
  });
  const blend = (index: number, other: number, smooth: boolean): readonly [number, number] => {
    const own = spans[index];
    const next = smooth ? spans[other] : undefined;
    if (!next || next.length <= 0) return [own.nz, own.nr];
    const nz = own.nz + next.nz;
    const nr = own.nr + next.nr;
    const length = Math.hypot(nz, nr) || 1;
    return [nz / length, nr / length];
  };
  const soup = new Soup();
  let run = 0;
  spans.forEach((span, index) => {
    if (span.length <= 0) return;
    const start = blend(index, index - 1, span.a.smooth);
    const end = blend(index, index + 1, span.b.smooth);
    const wear = span.a.worn ? 1 : 0;
    for (let step = 0; step < segments; step++) {
      const angles = [(step / segments) * Math.PI * 2, ((step + 1) / segments) * Math.PI * 2];
      const facing = (angles[0] + angles[1]) / 2;
      const corner = (station: Station, normal: readonly [number, number], side: 0 | 1, v: number): void => {
        const angle = angles[side];
        const around = options.faceted ? facing : angle;
        soup.vertex(
          [station.r * Math.cos(angle), station.r * Math.sin(angle), station.z],
          [normal[1] * Math.cos(around), normal[1] * Math.sin(around), normal[0]],
          (step + side) / segments,
          v,
          wear,
        );
      };
      const v0 = run * 100;
      const v1 = (run + span.length) * 100;
      if (span.a.r > AXIS) {
        corner(span.a, start, 0, v0);
        corner(span.a, start, 1, v0);
        corner(span.b, end, 0, v1);
      }
      if (span.b.r > AXIS) {
        corner(span.a, start, 1, v0);
        corner(span.b, end, 1, v1);
        corner(span.b, end, 0, v1);
      }
    }
    run += span.length;
  });
  return soup.build();
}

/** A box centred on the origin with every edge and corner cut by `chamfer`. */
export function block(size: Vec3, chamfer = 0.0005): THREE.BufferGeometry {
  const half = size.map((side) => side / 2);
  const cut = Math.min(chamfer, ...half.map((side) => side * 0.45));
  const soup = new Soup();
  const centre = new THREE.Vector3();
  const signs = [-1, 1] as const;
  const point = (values: readonly number[]): THREE.Vector3 => new THREE.Vector3(values[0], values[1], values[2]);
  for (let axis = 0; axis < 3; axis++) {
    const [u, v] = [(axis + 1) % 3, (axis + 2) % 3];
    for (const side of signs) {
      // The face itself, inset by the chamfer.
      const face = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => {
        const values = [0, 0, 0];
        values[axis] = side * half[axis];
        values[u] = su * (half[u] - cut);
        values[v] = sv * (half[v] - cut);
        return point(values);
      });
      soup.polygon(face, centre, 0);
      // The bevel between this face and the next axis's faces (each edge is visited once).
      for (const other of signs) {
        const strip = [-1, 1].flatMap((along, index) => {
          const onFace = [0, 0, 0];
          onFace[axis] = side * half[axis];
          onFace[u] = other * (half[u] - cut);
          onFace[v] = along * (half[v] - cut);
          const onNext = [...onFace];
          onNext[axis] = side * (half[axis] - cut);
          onNext[u] = other * half[u];
          return index === 0 ? [point(onFace), point(onNext)] : [point(onNext), point(onFace)];
        });
        soup.polygon(strip, centre, 1);
      }
    }
  }
  for (const sx of signs) {
    for (const sy of signs) {
      for (const sz of signs) {
        const sign = [sx, sy, sz];
        const corner = [0, 1, 2].map((axis) => {
          const values = sign.map((s, index) => s * (half[index] - cut));
          values[axis] = sign[axis] * half[axis];
          return point(values);
        });
        soup.polygon(corner, centre, 1);
      }
    }
  }
  return soup.build();
}

/** A ring of straight knurling about +Z between `z0` and `z1`: `teeth` ridges, `depth` deep, closed at both ends. */
export function knurled(z0: number, z1: number, radius: number, depth: number, teeth: number): THREE.BufferGeometry {
  const soup = new Soup();
  const count = teeth * 2;
  const rim = (index: number, z: number): THREE.Vector3 => {
    const angle = (index / count) * Math.PI * 2;
    const r = index % 2 === 0 ? radius : radius - depth;
    return new THREE.Vector3(r * Math.cos(angle), r * Math.sin(angle), z);
  };
  const inside = new THREE.Vector3(0, 0, (z0 + z1) / 2);
  for (let index = 0; index < count; index++) {
    soup.polygon([rim(index, z0), rim(index + 1, z0), rim(index + 1, z1), rim(index, z1)], inside, 0);
    for (const z of [z0, z1]) soup.polygon([new THREE.Vector3(0, 0, z), rim(index, z), rim(index + 1, z)], inside, 0);
  }
  return soup.build();
}

/** Any three geometry, made mergeable with the builders above. */
export function plain(geometry: THREE.BufferGeometry, wear = 0): THREE.BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  for (const name of Object.keys(flat.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') flat.deleteAttribute(name);
  }
  flat.setAttribute('wear', new THREE.Float32BufferAttribute(new Float32Array(flat.attributes.position.count).fill(wear), 1));
  return flat;
}

/** Turns a geometry built about +Z so its axis points along `axis`, then moves its origin to `at`. */
export function place(geometry: THREE.BufferGeometry, at: Vec3, axis: Vec3 = [0, 0, 1]): THREE.BufferGeometry {
  const turn = new THREE.Quaternion().setFromUnitVectors(FORWARD, new THREE.Vector3(...axis).normalize());
  geometry.applyQuaternion(turn);
  geometry.translate(...at);
  return geometry;
}

/** Sets every vertex's uv, for parts whose material reads uv as data. */
export function withUv(geometry: THREE.BufferGeometry, u: number, v: number): THREE.BufferGeometry {
  const uv = geometry.attributes.uv;
  for (let index = 0; index < uv.count; index++) uv.setXY(index, u, v);
  return geometry;
}

export function merge(parts: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries([...parts]);
  if (!merged) throw new Error('M24 detail parts do not share one attribute layout');
  return merged;
}

export function triangleCount(geometry: THREE.BufferGeometry): number {
  return (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
}

/** Code-built parts sorted by finish; each list becomes one mesh. */
export interface PartBins {
  /** Worn black anodise. */
  readonly black: THREE.BufferGeometry[];
  /** Oiled steel fasteners and springs. */
  readonly steel: THREE.BufferGeometry[];
  /** Engraved scales. */
  readonly marks: THREE.BufferGeometry[];
  /** Rubber and blacked interiors. */
  readonly matte: THREE.BufferGeometry[];
}

export function emptyBins(): PartBins {
  return { black: [], steel: [], marks: [], matte: [] };
}
