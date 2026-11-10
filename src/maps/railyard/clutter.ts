import * as THREE from 'three/webgpu';
import type { Kit } from './kit';
import { logoGeometry, type LogoText, type Materials } from './materials';

const SAFETY_YELLOW = 0xc79a1c;
const RUBBER = 0x141516;
const TYRE_HEIGHT = 0.25;

/** Small yard furniture that the big props do not cover. Everything is baked into the level batches. */
export class Clutter {
  constructor(
    private readonly kit: Kit,
    private readonly m: Materials,
  ) {}

  /** Used truck tyres lying in a stack. Five make chest-high cover. */
  tyres(x: number, z: number, count: number): void {
    const { kit, m } = this;
    // Lathed section: flat tread, rounded shoulders, open at the bead.
    const section = [[0.27, -0.1], [0.36, -0.125], [0.47, -0.115], [0.515, -0.07], [0.515, 0.07], [0.47, 0.115], [0.36, 0.125], [0.27, 0.1]];
    const tyre = new THREE.LatheGeometry(section.map(([r, y]) => new THREE.Vector2(r, y)), 20);
    for (let i = 0; i < count; i++) {
      const pose = kit.transform(x + kit.range(-0.05, 0.05), 0.125 + i * TYRE_HEIGHT, z + kit.range(-0.05, 0.05), kit.range(0, Math.PI));
      kit.add(m.matte, tyre, pose, RUBBER);
    }
    tyre.dispose();
    kit.collide(1.03, count * TYRE_HEIGHT, 1.03, x, 0, z, 'dirt');
  }

  /** Steel bollard in safety yellow with a black band. */
  bollard(x: number, z: number): void {
    const { kit, m } = this;
    kit.post(m.steel, 0.085, 1.0, x, 0, z, SAFETY_YELLOW, 10);
    kit.post(m.matte, 0.088, 0.14, x, 0.7, z, RUBBER, 10);
    kit.post(m.steel, 0.14, 0.02, x, 0, z, 0x3a3d3f, 10);
    kit.collide(0.2, 1.0, 0.2, x, 0, z, 'metal');
  }

  /** Cast-iron inspection cover set in a concrete collar. */
  manhole(x: number, z: number): void {
    const { kit, m } = this;
    const collar = new THREE.CylinderGeometry(0.5, 0.5, 0.008, 20);
    const lid = new THREE.CylinderGeometry(0.38, 0.38, 0.012, 20);
    kit.add(m.wall, collar, new THREE.Matrix4().makeTranslation(x, 0.003, z), 0x9a9891);
    kit.add(m.rawSteel, lid, kit.transform(x, 0.006, z, kit.range(0, Math.PI)), 0x3d3a37);
    collar.dispose();
    lid.dispose();
    for (const offset of [-0.2, -0.07, 0.07, 0.2]) kit.box(m.rawSteel, 0.5, 0.004, 0.03, x, 0.012, z + offset, { color: 0x57534f });
  }

  /** Slot drain: a dark slit between two steel edge rails, set in the paving from (ax, az) to (bx, bz). */
  drain(ax: number, az: number, bx: number, bz: number): void {
    const { kit, m } = this;
    const length = Math.hypot(bx - ax, bz - az);
    const yaw = Math.atan2(bx - ax, bz - az);
    const midX = (ax + bx) / 2;
    const midZ = (az + bz) / 2;
    kit.box(m.matte, 0.05, 0.004, length, midX, 0.003, midZ, { yaw, color: 0x050505 });
    for (const side of [-0.06, 0.06]) {
      kit.box(m.rawSteel, 0.07, 0.006, length, midX + Math.cos(yaw) * side, 0.001, midZ - Math.sin(yaw) * side, { yaw, color: 0x3d3a37 });
    }
  }

  /** Cable hanging between two points; `sag` is the drop at mid-span. */
  cable(a: THREE.Vector3, b: THREE.Vector3, sag: number, thickness = 0.024): void {
    const segments = 10;
    let previous = a;
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const point = new THREE.Vector3().lerpVectors(a, b, t);
      point.y -= sag * 4 * t * (1 - t);
      this.kit.beam(this.m.matte, previous, point, thickness, thickness, 0x0c0c0d);
      previous = point;
    }
  }

  /** Two-wheeled waste bin. */
  bin(x: number, z: number, yaw: number, color: number): void {
    const { kit, m } = this;
    kit.box(m.matte, 0.56, 0.92, 0.7, x, 0.06, z, { yaw, color });
    kit.box(m.matte, 0.6, 0.05, 0.76, x, 0.98, z, { yaw, color });
    kit.box(m.matte, 0.5, 0.04, 0.04, x - Math.sin(yaw) * 0.4, 0.95, z - Math.cos(yaw) * 0.4, { yaw, color: RUBBER });
    kit.collide(0.6, 1.03, 0.76, x, 0, z, 'wood', yaw);
  }

  /** Text plate; the lettering faces along (nx, nz). Returns nothing and adds no collider. */
  plate(x: number, y: number, z: number, nx: number, nz: number, text: LogoText, width: number, ground: number, ink: number): void {
    const { kit, m } = this;
    const yaw = Math.atan2(nx, nz);
    const height = width / 8 + 0.1;
    kit.box(m.steel, width + 0.1, height, 0.02, x, y - height / 2, z, { yaw, color: ground });
    const text3d = logoGeometry(text, width);
    kit.add(m.lettering, text3d, new THREE.Matrix4().makeRotationY(yaw).setPosition(x + nx * 0.013, y, z + nz * 0.013), ink);
    text3d.dispose();
  }

  /** Sign on a galvanised post, readable from the direction (nx, nz) points to. */
  signPost(x: number, z: number, nx: number, nz: number, text: LogoText, ground = SAFETY_YELLOW, ink = 0x141516): void {
    this.kit.post(this.m.rawSteel, 0.03, 2.75, x, 0, z, 0x9a9d9c, 8);
    this.plate(x + nx * 0.045, 2.5, z + nz * 0.045, nx, nz, text, 1.25, ground, ink);
    this.kit.collide(0.1, 2.75, 0.1, x, 0, z, 'metal');
  }

  /** Fire point: red back board and an extinguisher, on a wall whose outward normal is (nx, nz). */
  firePoint(x: number, z: number, nx: number, nz: number): void {
    const { kit, m } = this;
    const yaw = Math.atan2(nx, nz);
    kit.box(m.steel, 0.42, 0.95, 0.02, x + nx * 0.01, 0.85, z + nz * 0.01, { yaw, color: 0x8f1f18 });
    const body = new THREE.CylinderGeometry(0.075, 0.075, 0.48, 12);
    kit.add(m.steel, body, new THREE.Matrix4().makeTranslation(x + nx * 0.1, 1.2, z + nz * 0.1), 0xa3211a);
    body.dispose();
    kit.post(m.matte, 0.03, 0.09, x + nx * 0.1, 1.44, z + nz * 0.1, RUBBER, 8);
    kit.box(m.matte, 0.3, 0.2, 0.004, x + nx * 0.022, 1.52, z + nz * 0.022, { yaw, color: 0xd9d8d0 });
  }

  /** Electrical cabinet against a wall, with a conduit rising from it. (nx, nz) is the wall's outward normal. */
  cabinet(x: number, z: number, nx: number, nz: number, conduitTop = 4.5): void {
    const { kit, m } = this;
    const yaw = Math.atan2(nx, nz);
    const cx = x + nx * 0.17;
    const cz = z + nz * 0.17;
    kit.box(m.wall, 0.95, 0.12, 0.42, cx, 0, cz, { yaw, tile: 2.71 });
    kit.box(m.steel, 0.85, 1.55, 0.32, cx, 0.12, cz, { yaw, color: 0x73807c });
    kit.box(m.steel, 0.02, 1.45, 0.006, cx + nx * 0.162, 0.17, cz + nz * 0.162, { yaw, color: 0x2a2c2e });
    kit.box(m.hazard, 0.2, 0.2, 0.006, cx + nx * 0.163 + nz * 0.22, 1.2, cz + nz * 0.163 - nx * 0.22, { yaw });
    kit.box(m.steel, 0.9, 0.03, 0.36, cx, 1.67, cz, { yaw, color: 0x5a6562 });
    kit.post(m.rawSteel, 0.022, conduitTop - 1.7, x + nx * 0.05 + nz * 0.25, 1.7, z + nz * 0.05 - nx * 0.25, 0x8f9394, 6);
    kit.post(m.rawSteel, 0.022, conduitTop - 1.7, x + nx * 0.05 + nz * 0.32, 1.7, z + nz * 0.05 - nx * 0.32, 0x8f9394, 6);
    kit.collide(0.9, 1.7, 0.36, cx, 0, cz, 'metal', yaw);
  }

  /** Rainwater pipe from `top` to the ground. */
  downpipe(x: number, z: number, top: number): void {
    const { kit, m } = this;
    kit.post(m.steel, 0.055, top - 0.12, x, 0.12, z, 0x4a5258, 8);
    for (let y = 1.4; y < top; y += 2.2) kit.post(m.rawSteel, 0.065, 0.05, x, y, z, 0x8f9394, 8);
    kit.box(m.steel, 0.16, 0.12, 0.2, x, 0, z, { color: 0x4a5258 });
  }
}
