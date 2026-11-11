import * as THREE from 'three/webgpu';
import { GRENADE, predictArc } from '../weapons/grenade-math';
import { RENDER_ORDER, leaveSurfaceDataAlone, type FxEnv } from './shared';

/** Paper white for the path, the interface's one blue for where it ends. */
const ARC_COLOR = 0xf7f5ef;
const MARKER_COLOR = 0x4c8dff;
const ARC_OPACITY = 0.7;
/** Half the ribbon's width per metre from the eye, so it stays a thin line at any range. */
const HALF_WIDTH_PER_METRE = 0.0011;
const MIN_HALF_WIDTH = 0.0025;
/** The first stretch of the path is left out so the line does not start inside the view model. */
const SKIP_POINTS = 2;
/** The end marker faces the eye and keeps about the same size on screen: its radius per metre of range. */
const MARKER_RADIUS_PER_METRE = 0.016;
const MIN_MARKER_RADIUS = 0.1;
/** Where the pieces sit while the loading screen compiles their shaders: under the level, out of sight. */
const PARKED_Y = -400;

/**
 * The predicted path of the grenade being aimed: a thin ribbon from the hand
 * and a ring around the point where it will go off. Rebuilt from the same integrator the thrown
 * grenade uses, and only when the aim has moved.
 */
export class GrenadeArc {
  private readonly points = new Float32Array(GRENADE.maxArcPoints * 3);
  private readonly positions = new Float32Array(GRENADE.maxArcPoints * 2 * 3);
  private readonly attribute = new THREE.BufferAttribute(this.positions, 3);
  private readonly ribbon: THREE.Mesh;
  private readonly marker: THREE.Mesh;
  private readonly materials: THREE.MeshBasicNodeMaterial[] = [];
  private readonly lastOrigin = new THREE.Vector3(Infinity, 0, 0);
  private readonly lastVelocity = new THREE.Vector3();
  private readonly lastEye = new THREE.Vector3();
  private readonly point = new THREE.Vector3();
  private readonly tangent = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private count = 0;

  constructor(private readonly env: FxEnv) {
    this.attribute.setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this.attribute);
    const index: number[] = [];
    for (let i = 0; i < GRENADE.maxArcPoints - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geometry.setIndex(index);
    this.ribbon = this.piece(geometry, ARC_COLOR, ARC_OPACITY);

    // A unit ring, scaled by range when it is placed. Drawn over everything, so a spot behind cover still shows.
    this.marker = this.piece(new THREE.RingGeometry(0.8, 1, 48), MARKER_COLOR, 0.95);
    (this.marker.material as THREE.Material).depthTest = false;
    this.park();
  }

  /** Put both pieces in view of the renderer (not the player) so their shaders compile during loading. */
  park(): void {
    this.positions.fill(0);
    this.positions[1] = this.positions[4] = this.positions[7] = this.positions[10] = PARKED_Y;
    this.positions[3] = this.positions[9] = 1;
    this.positions[8] = this.positions[11] = 1;
    this.attribute.needsUpdate = true;
    this.ribbon.geometry.setDrawRange(0, 6);
    this.marker.position.set(0, PARKED_Y, 0);
    this.ribbon.visible = this.marker.visible = true;
    this.lastOrigin.x = Infinity;
  }

  hide(): void {
    this.ribbon.visible = this.marker.visible = false;
  }

  /** Draw the path of a throw from `origin` at `velocity`. Call every frame while aiming. */
  show(origin: THREE.Vector3, velocity: THREE.Vector3): void {
    const eye = this.env.camera.position;
    const moved = !origin.equals(this.lastOrigin) || !velocity.equals(this.lastVelocity);
    if (moved) {
      this.lastOrigin.copy(origin);
      this.lastVelocity.copy(velocity);
      this.count = predictArc(origin, velocity, this.env.ctx.world, this.points);
    }
    if (moved || !eye.equals(this.lastEye)) {
      this.lastEye.copy(eye);
      this.build(eye);
    }
    this.ribbon.visible = this.count - SKIP_POINTS >= 2;
    this.marker.visible = true;
  }

  dispose(): void {
    for (const mesh of [this.ribbon, this.marker]) {
      this.env.root.remove(mesh);
      mesh.geometry.dispose();
    }
    for (const material of this.materials) material.dispose();
  }

  private piece(geometry: THREE.BufferGeometry, color: number, opacity: number): THREE.Mesh {
    const material = new THREE.MeshBasicNodeMaterial({
      color,
      opacity,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    leaveSurfaceDataAlone(mesh, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = RENDER_ORDER.tracers;
    this.materials.push(material);
    this.env.root.add(mesh);
    return mesh;
  }

  /** Turn the predicted points into a ribbon that faces the eye. */
  private build(eye: THREE.Vector3): void {
    const { points, positions, point, tangent, side } = this;
    const count = this.count;
    const last = (count - 1) * 3;
    const marker = this.marker;
    marker.position.set(points[last]!, points[last + 1]!, points[last + 2]!);
    marker.quaternion.copy(this.env.camera.quaternion);
    marker.scale.setScalar(Math.max(MIN_MARKER_RADIUS, marker.position.distanceTo(eye) * MARKER_RADIUS_PER_METRE));
    const used = count - SKIP_POINTS;
    if (used < 2) return;
    for (let i = 0; i < used; i++) {
      const at = (i + SKIP_POINTS) * 3;
      const before = Math.max(SKIP_POINTS, i + SKIP_POINTS - 1) * 3;
      const after = Math.min(count - 1, i + SKIP_POINTS + 1) * 3;
      point.set(points[at]!, points[at + 1]!, points[at + 2]!);
      tangent.set(points[after]! - points[before]!, points[after + 1]! - points[before + 1]!, points[after + 2]! - points[before + 2]!);
      side.subVectors(point, eye);
      const half = Math.max(MIN_HALF_WIDTH, side.length() * HALF_WIDTH_PER_METRE);
      side.cross(tangent);
      const length = side.length();
      // Looking straight along the path there is no sideways direction; any will do.
      if (length < 1e-6) side.set(half, 0, 0);
      else side.multiplyScalar(half / length);
      const o = i * 6;
      positions[o] = point.x - side.x;
      positions[o + 1] = point.y - side.y;
      positions[o + 2] = point.z - side.z;
      positions[o + 3] = point.x + side.x;
      positions[o + 4] = point.y + side.y;
      positions[o + 5] = point.z + side.z;
    }
    this.attribute.clearUpdateRanges();
    this.attribute.addUpdateRange(0, used * 6);
    this.attribute.needsUpdate = true;
    this.ribbon.geometry.setDrawRange(0, (used - 1) * 6);
  }
}
