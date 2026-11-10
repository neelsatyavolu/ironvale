import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Line3,
  Matrix4,
  Mesh,
  Ray,
  Vector3,
  type Object3D,
} from 'three/webgpu';
import { MeshBVH, type ExtendedTriangle } from 'three-mesh-bvh';
import type { CapsuleMoveResult, RayHit, Surface, World } from './types';

const SURFACES: readonly Surface[] = [
  'concrete',
  'cobble',
  'asphalt',
  'gravel',
  'dirt',
  'grass',
  'sand',
  'wood',
  'metal',
  'plaster',
  'glass',
  'water',
  'foliage',
  'flesh',
];

/** Capsule sub-steps never move further than this fraction of the radius. */
const MAX_STEP_FRACTION = 0.5;
const MAX_SUBSTEPS = 6;
/** Slopes steeper than this (normal.y below it) do not count as ground. */
const GROUND_NORMAL_Y = 0.55;

interface PendingCollider {
  readonly positions: Float32Array;
  readonly surface: number;
}

/**
 * Static triangle-soup collision world. One merged geometry and one BVH hold
 * every collider; a per-vertex byte records the surface kind.
 */
export class CollisionWorld implements World {
  readonly bounds = new Box3();
  private pending: PendingCollider[] = [];
  private pendingBoundary: Float32Array[] = [];
  private bvh: MeshBVH | null = null;
  /** Limits of the playable area: bodies collide with these, bullets and sight lines do not. */
  private boundary: MeshBVH | null = null;
  private surfaceAttr: BufferAttribute | null = null;
  private indexAttr: BufferAttribute | null = null;

  private readonly ray = new Ray();
  private readonly segment = new Line3();
  private readonly box = new Box3();
  private readonly triPoint = new Vector3();
  private readonly capPoint = new Vector3();
  private readonly push = new Vector3();

  addCollider(geometry: BufferGeometry, matrix: Matrix4, surface: Surface): void {
    const positions = bakePositions(geometry, matrix);
    if (positions) this.pending.push({ positions, surface: SURFACES.indexOf(surface) });
  }

  addBoundary(geometry: BufferGeometry, matrix: Matrix4): void {
    const positions = bakePositions(geometry, matrix);
    if (positions) this.pendingBoundary.push(positions);
  }

  addColliderObject(root: Object3D, surface: Surface): void {
    root.updateWorldMatrix(true, true);
    root.traverse((child) => {
      if (child instanceof Mesh && child.geometry instanceof BufferGeometry) {
        this.addCollider(child.geometry, child.matrixWorld, surface);
      }
    });
  }

  build(): void {
    const total = this.pending.reduce((sum, c) => sum + c.positions.length, 0);
    if (total === 0) throw new Error('CollisionWorld.build() called with no colliders');
    const positions = new Float32Array(total);
    const surfaces = new Uint8Array(total / 3);
    let offset = 0;
    for (const collider of this.pending) {
      positions.set(collider.positions, offset);
      surfaces.fill(collider.surface, offset / 3, (offset + collider.positions.length) / 3);
      offset += collider.positions.length;
    }
    this.pending = [];
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    this.surfaceAttr = new BufferAttribute(surfaces, 1);
    this.bvh = new MeshBVH(geometry, { targetLeafSize: 8 });
    this.indexAttr = geometry.index;
    geometry.computeBoundingBox();
    if (geometry.boundingBox) this.bounds.copy(geometry.boundingBox);

    const boundaryTotal = this.pendingBoundary.reduce((sum, p) => sum + p.length, 0);
    if (boundaryTotal > 0) {
      const merged = new Float32Array(boundaryTotal);
      let at = 0;
      for (const part of this.pendingBoundary) {
        merged.set(part, at);
        at += part.length;
      }
      const boundaryGeometry = new BufferGeometry();
      boundaryGeometry.setAttribute('position', new BufferAttribute(merged, 3));
      this.boundary = new MeshBVH(boundaryGeometry, { targetLeafSize: 8 });
    }
    this.pendingBoundary = [];
  }

  raycast(origin: Vector3, direction: Vector3, maxDistance: number): RayHit | null {
    const bvh = this.requireBvh();
    this.ray.origin.copy(origin);
    this.ray.direction.copy(direction).normalize();
    const hit = bvh.raycastFirst(this.ray, DoubleSide, 0, maxDistance);
    if (!hit || !hit.face) return null;
    const normal = hit.face.normal.clone();
    // Double-sided hits can report a back-facing normal; always face the shooter.
    if (normal.dot(this.ray.direction) > 0) normal.negate();
    return {
      point: hit.point.clone(),
      normal,
      distance: hit.distance,
      surface: this.surfaceOfFace(hit.faceIndex ?? 0),
    };
  }

  lineOfSight(a: Vector3, b: Vector3): boolean {
    const bvh = this.requireBvh();
    this.ray.origin.copy(a);
    this.ray.direction.subVectors(b, a);
    const distance = this.ray.direction.length();
    if (distance < 1e-4) return true;
    this.ray.direction.divideScalar(distance);
    return bvh.raycastFirst(this.ray, DoubleSide, 0, distance - 0.02) === null;
  }

  groundHeight(x: number, z: number, fromY: number, maxDrop = 50): number | null {
    const bvh = this.requireBvh();
    this.ray.origin.set(x, fromY, z);
    this.ray.direction.set(0, -1, 0);
    const hit = bvh.raycastFirst(this.ray, DoubleSide, 0, maxDrop);
    return hit ? hit.point.y : null;
  }

  moveCapsule(
    position: Vector3,
    velocity: Vector3,
    dt: number,
    radius: number,
    height: number,
  ): CapsuleMoveResult {
    const bvh = this.requireBvh();
    const pos = position.clone();
    const vel = velocity.clone();
    const travel = vel.length() * dt;
    const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(travel / (radius * MAX_STEP_FRACTION))));
    const stepDt = dt / steps;
    let onGround = false;

    for (let step = 0; step < steps; step++) {
      pos.addScaledVector(vel, stepDt);
      this.segment.start.set(pos.x, pos.y + radius, pos.z);
      this.segment.end.set(pos.x, pos.y + Math.max(radius, height - radius), pos.z);
      this.box.makeEmpty();
      this.box.expandByPoint(this.segment.start);
      this.box.expandByPoint(this.segment.end);
      this.box.expandByScalar(radius);

      let groundedThisStep = false;
      const callbacks = {
        intersectsBounds: (box: Box3) => box.intersectsBox(this.box),
        intersectsTriangle: (tri: ExtendedTriangle) => {
          const distance = tri.closestPointToSegment(this.segment, this.triPoint, this.capPoint);
          if (distance >= radius) return false;
          const depth = radius - distance;
          this.push.subVectors(this.capPoint, this.triPoint);
          if (this.push.lengthSq() < 1e-10) tri.getNormal(this.push);
          else this.push.normalize();
          if (this.push.y > GROUND_NORMAL_Y) groundedThisStep = true;
          this.segment.start.addScaledVector(this.push, depth);
          this.segment.end.addScaledVector(this.push, depth);
          // Remove the velocity component pushing into the surface.
          const into = vel.dot(this.push);
          if (into < 0) vel.addScaledVector(this.push, -into);
          return false;
        },
      };
      bvh.shapecast(callbacks);
      this.boundary?.shapecast(callbacks);

      pos.set(this.segment.start.x, this.segment.start.y - radius, this.segment.start.z);
      onGround = groundedThisStep;
    }

    let groundSurface: Surface | null = null;
    if (onGround) {
      this.ray.origin.set(pos.x, pos.y + radius, pos.z);
      this.ray.direction.set(0, -1, 0);
      const below = bvh.raycastFirst(this.ray, DoubleSide, 0, radius + 0.4);
      groundSurface = below ? this.surfaceOfFace(below.faceIndex ?? 0) : null;
    }
    return { position: pos, velocity: vel, onGround, groundSurface };
  }

  capsuleFits(position: Vector3, radius: number, height: number): boolean {
    const bvh = this.requireBvh();
    // Lift the bottom a little so standing on the floor does not count as touching.
    const lift = 0.05;
    this.segment.start.set(position.x, position.y + radius + lift, position.z);
    this.segment.end.set(position.x, position.y + Math.max(radius + lift, height - radius), position.z);
    this.box.makeEmpty();
    this.box.expandByPoint(this.segment.start);
    this.box.expandByPoint(this.segment.end);
    this.box.expandByScalar(radius);
    const callbacks = {
      intersectsBounds: (box: Box3) => box.intersectsBox(this.box),
      intersectsTriangle: (tri: ExtendedTriangle) =>
        tri.closestPointToSegment(this.segment, this.triPoint, this.capPoint) < radius,
    };
    return !bvh.shapecast(callbacks) && !(this.boundary?.shapecast(callbacks) ?? false);
  }

  private surfaceOfFace(faceIndex: number): Surface {
    if (!this.surfaceAttr || !this.indexAttr) return 'concrete';
    const vertex = this.indexAttr.getX(faceIndex * 3);
    return SURFACES[this.surfaceAttr.getX(vertex)] ?? 'concrete';
  }

  private requireBvh(): MeshBVH {
    if (!this.bvh) throw new Error('CollisionWorld used before build()');
    return this.bvh;
  }
}

/** World-space, non-indexed vertex positions of a geometry, or null when it has none. */
function bakePositions(geometry: BufferGeometry, matrix: Matrix4): Float32Array | null {
  const source = geometry.index ? geometry.toNonIndexed() : geometry;
  const attr = source.getAttribute('position');
  if (!attr) return null;
  const positions = new Float32Array(attr.count * 3);
  const v = new Vector3();
  for (let i = 0; i < attr.count; i++) {
    v.fromBufferAttribute(attr, i).applyMatrix4(matrix);
    positions[i * 3] = v.x;
    positions[i * 3 + 1] = v.y;
    positions[i * 3 + 2] = v.z;
  }
  if (source !== geometry) source.dispose();
  return positions;
}
