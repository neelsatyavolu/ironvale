import * as THREE from 'three/webgpu';
import type { GunModel } from '../../game/contracts';
import type { WeaponId } from '../models/api';
import { gunMaterials, lensMaterial } from '../models/materials';

/**
 * Stand-in guns built from boxes and cylinders, used for any weapon whose
 * `models/<id>.gun.ts` module is missing or fails to build. Same conventions
 * as the real models: barrel along -Z, up +Y, origin at the pistol grip, real
 * scale, with every anchor and moving part the view model animates.
 */

type Material = THREE.Material;
type Parts = { -readonly [K in keyof GunModel['parts']]: GunModel['parts'][K] };

/** Accumulates meshes and anchors into a gun. */
class Builder {
  readonly root = new THREE.Group();
  readonly parts: Parts = {};
  readonly muzzle = this.anchor('anchor_muzzle');
  readonly ejection = this.anchor('anchor_ejection');
  readonly sight = this.anchor('anchor_sight');
  readonly triggerGrip = this.anchor('grip_trigger');
  readonly supportGrip = this.anchor('grip_support');
  cycleTravel = 0.06;
  private target: THREE.Object3D = this.root;

  anchor(name: string): THREE.Object3D {
    const object = new THREE.Object3D();
    object.name = name;
    this.root.add(object);
    return object;
  }

  /** Start a moving part with its pivot at the given point; following shapes are added to it. */
  part(name: keyof Parts, x: number, y: number, z: number): THREE.Group {
    const group = new THREE.Group();
    group.name = `part_${name}`;
    group.position.set(x, y, z);
    this.root.add(group);
    this.parts[name] = group;
    this.target = group;
    return group;
  }

  /** Go back to adding shapes to the gun body. */
  body(): void {
    this.target = this.root;
  }

  /** Box centred at (x, y, z) in gun space; `pitch` tilts it about X. */
  box(material: Material, w: number, h: number, l: number, x: number, y: number, z: number, pitch = 0): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), material);
    mesh.rotation.x = pitch;
    return this.place(mesh, x, y, z);
  }

  /** Cylinder along Z from `zFront` to `zBack` at height y. */
  tube(material: Material, radius: number, zFront: number, zBack: number, y: number, x = 0, sides = 20): THREE.Mesh {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, Math.abs(zBack - zFront), sides), material);
    mesh.rotation.x = Math.PI / 2;
    return this.place(mesh, x, y, (zFront + zBack) / 2);
  }

  private place(mesh: THREE.Mesh, x: number, y: number, z: number): THREE.Mesh {
    // Positions are given in gun space; convert when adding to a part.
    mesh.position.set(x - this.target.position.x, y - this.target.position.y, z - this.target.position.z);
    this.target.add(mesh);
    return mesh;
  }

  finish(): GunModel {
    this.root.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return {
      root: this.root,
      muzzle: this.muzzle,
      ejection: this.ejection,
      sight: this.sight,
      parts: this.parts,
      cycleTravel: this.cycleTravel,
      grips: { trigger: this.triggerGrip, support: this.supportGrip },
    };
  }
}

/** Open sights: a front post and a rear notch, plus the eye point behind them. */
function ironSights(b: Builder, y: number, zFront: number, zRear: number, eyeRelief: number): void {
  const steel = gunMaterials.parkerized();
  b.box(steel, 0.0022, 0.016, 0.004, 0, y - 0.006, zFront);
  b.box(steel, 0.016, 0.004, 0.012, 0, y - 0.015, zFront);
  for (const side of [-1, 1]) b.box(steel, 0.004, 0.012, 0.005, side * 0.0052, y - 0.004, zRear);
  b.box(steel, 0.016, 0.005, 0.012, 0, y - 0.0125, zRear);
  b.sight.position.set(0, y, zRear + eyeRelief);
}

function pistolGrip(b: Builder, material: Material): void {
  b.box(material, 0.03, 0.095, 0.042, 0, -0.035, 0.016, -0.26);
  b.triggerGrip.position.set(0.016, -0.03, 0.012);
}

function triggerGuard(b: Builder, y: number, z: number): void {
  const steel = gunMaterials.parkerized();
  b.box(steel, 0.008, 0.003, 0.06, 0, y - 0.03, z);
  b.box(steel, 0.008, 0.03, 0.003, 0, y - 0.015, z - 0.03);
  b.part('trigger', 0, y, z + 0.004);
  b.box(steel, 0.005, 0.02, 0.005, 0, y - 0.012, z + 0.002, 0.25);
  b.body();
}

function m4a1(b: Builder): void {
  const alloy = gunMaterials.anodized();
  const poly = gunMaterials.polymer();
  const steel = gunMaterials.parkerized();
  const bore = 0.062;
  b.box(alloy, 0.044, 0.05, 0.2, 0, bore, -0.03);
  b.box(alloy, 0.04, 0.036, 0.15, 0, 0.022, -0.015);
  b.box(alloy, 0.03, 0.012, 0.19, 0, bore + 0.031, -0.03);
  b.tube(poly, 0.027, -0.39, -0.13, bore);
  b.tube(steel, 0.009, -0.52, -0.39, bore);
  b.tube(steel, 0.011, -0.56, -0.52, bore);
  b.box(steel, 0.012, 0.05, 0.02, 0, bore + 0.03, -0.4);
  b.tube(steel, 0.015, 0.07, 0.25, bore - 0.004);
  b.box(poly, 0.04, 0.11, 0.17, 0, 0.03, 0.245);
  pistolGrip(b, poly);
  triggerGuard(b, 0.006, -0.03);
  b.part('magazine', 0, 0.0, -0.085);
  b.box(steel, 0.024, 0.17, 0.058, 0, -0.085, -0.09, 0.16);
  b.part('bolt', 0.0225, bore + 0.002, -0.03);
  b.box(gunMaterials.bareSteel(), 0.003, 0.02, 0.07, 0.0225, bore + 0.002, -0.03);
  b.part('chargingHandle', 0, bore + 0.03, 0.068);
  b.box(steel, 0.036, 0.008, 0.016, 0, bore + 0.03, 0.068);
  b.body();
  ironSights(b, bore + 0.062, -0.4, 0.035, 0.11);
  b.muzzle.position.set(0, bore, -0.56);
  b.ejection.position.set(0.024, bore + 0.004, -0.03);
  b.supportGrip.position.set(0, bore - 0.03, -0.27);
  b.cycleTravel = 0.07;
}

function mp5(b: Builder): void {
  const steel = gunMaterials.parkerized();
  const poly = gunMaterials.polymer();
  const bore = 0.058;
  b.box(steel, 0.04, 0.05, 0.27, 0, bore + 0.004, -0.075);
  b.box(poly, 0.044, 0.05, 0.15, 0, bore - 0.012, -0.265);
  b.tube(steel, 0.013, -0.36, -0.12, bore + 0.03);
  b.tube(steel, 0.008, -0.39, -0.33, bore);
  b.box(poly, 0.04, 0.045, 0.1, 0, 0.012, -0.01);
  b.box(poly, 0.04, 0.1, 0.2, 0, bore - 0.03, 0.2);
  b.box(steel, 0.036, 0.04, 0.012, 0, bore + 0.03, 0.062);
  pistolGrip(b, poly);
  triggerGuard(b, 0.004, -0.028);
  b.part('magazine', 0, 0.01, -0.1);
  b.box(steel, 0.028, 0.1, 0.036, 0, -0.045, -0.105, 0.12);
  b.box(steel, 0.028, 0.1, 0.036, 0, -0.135, -0.126, 0.32);
  b.part('bolt', 0.021, bore + 0.006, -0.06);
  b.box(gunMaterials.bareSteel(), 0.003, 0.016, 0.06, 0.021, bore + 0.006, -0.06);
  b.part('chargingHandle', -0.022, bore + 0.03, -0.3);
  b.tube(poly, 0.008, -0.31, -0.29, bore + 0.03, -0.034, 10);
  b.body();
  b.tube(steel, 0.014, -0.352, -0.342, bore + 0.062, 0, 16);
  ironSights(b, bore + 0.062, -0.347, 0.04, 0.1);
  b.muzzle.position.set(0, bore, -0.39);
  b.ejection.position.set(0.022, bore + 0.01, -0.06);
  b.supportGrip.position.set(0, bore - 0.045, -0.26);
  b.cycleTravel = 0.06;
}

function m24(b: Builder): void {
  const steel = gunMaterials.bluedSteel();
  const stock = gunMaterials.oliveDrab();
  const bore = 0.068;
  const scopeY = bore + 0.052;
  b.box(stock, 0.05, 0.056, 0.6, 0, bore - 0.036, -0.12);
  b.box(stock, 0.044, 0.07, 0.14, 0, bore - 0.062, 0.13, 0.3);
  b.box(stock, 0.046, 0.12, 0.26, 0, bore - 0.085, 0.31, 0.08);
  b.tube(steel, 0.017, -0.14, 0.09, bore);
  b.tube(steel, 0.0115, -0.76, -0.14, bore);
  triggerGuard(b, bore - 0.062, -0.01);
  b.tube(gunMaterials.anodized(), 0.015, -0.2, 0.08, scopeY);
  b.tube(gunMaterials.anodized(), 0.024, -0.28, -0.2, scopeY, 0, 24);
  b.tube(gunMaterials.anodized(), 0.02, 0.08, 0.14, scopeY, 0, 24);
  b.tube(lensMaterial(), 0.022, -0.279, -0.277, scopeY, 0, 24);
  b.tube(lensMaterial(), 0.018, 0.137, 0.139, scopeY, 0, 24);
  b.tube(gunMaterials.anodized(), 0.008, -0.05, -0.03, scopeY + 0.022, 0, 12);
  for (const z of [-0.12, 0.03]) b.box(steel, 0.02, 0.04, 0.02, 0, bore + 0.025, z);
  b.part('magazine', 0, bore - 0.06, -0.09);
  b.box(steel, 0.026, 0.012, 0.09, 0, bore - 0.066, -0.09);
  b.part('bolt', 0, bore, 0.07);
  b.tube(gunMaterials.bareSteel(), 0.009, 0.05, 0.1, bore, 0, 12);
  b.box(gunMaterials.bareSteel(), 0.04, 0.008, 0.008, 0.028, bore - 0.006, 0.085);
  b.tube(gunMaterials.polymer(), 0.011, 0.073, 0.097, bore - 0.014, 0.05, 12);
  b.body();
  b.sight.position.set(0, scopeY, 0.225);
  b.muzzle.position.set(0, bore, -0.76);
  b.ejection.position.set(0.02, bore + 0.006, -0.02);
  b.triggerGrip.position.set(0.02, bore - 0.06, 0.085);
  b.triggerGrip.rotation.x = -0.35;
  b.supportGrip.position.set(0, bore - 0.066, -0.28);
  b.cycleTravel = 0.1;
}

function m249(b: Builder): void {
  const steel = gunMaterials.parkerized();
  const poly = gunMaterials.polymer();
  const bore = 0.07;
  b.box(steel, 0.056, 0.085, 0.4, 0, bore - 0.004, -0.1);
  b.tube(steel, 0.012, -0.78, -0.3, bore + 0.006);
  b.tube(steel, 0.014, -0.82, -0.78, bore + 0.006);
  b.tube(steel, 0.009, -0.62, -0.3, bore - 0.026);
  b.box(poly, 0.058, 0.05, 0.2, 0, bore - 0.036, -0.4);
  b.box(steel, 0.01, 0.03, 0.16, 0, bore + 0.075, -0.3);
  b.box(poly, 0.044, 0.1, 0.1, 0, bore - 0.02, 0.3);
  for (const y of [bore + 0.02, bore - 0.05]) b.tube(steel, 0.008, 0.1, 0.26, y);
  for (const side of [-1, 1]) b.tube(steel, 0.005, -0.66, -0.4, bore - 0.05, side * 0.02, 8);
  pistolGrip(b, poly);
  triggerGuard(b, 0.008, -0.03);
  b.part('cover', 0, bore + 0.042, 0.04);
  b.box(steel, 0.054, 0.02, 0.25, 0, bore + 0.05, -0.085);
  b.part('magazine', -0.04, bore - 0.05, -0.15);
  b.box(gunMaterials.oliveDrab(), 0.1, 0.12, 0.15, -0.045, bore - 0.11, -0.15);
  b.part('chargingHandle', 0.032, bore - 0.005, -0.12);
  b.box(poly, 0.016, 0.014, 0.03, 0.036, bore - 0.005, -0.12);
  b.part('bolt', 0.0285, bore + 0.01, -0.06);
  b.box(gunMaterials.bareSteel(), 0.003, 0.02, 0.06, 0.0285, bore + 0.01, -0.06);
  b.body();
  ironSights(b, bore + 0.085, -0.76, 0.02, 0.12);
  b.muzzle.position.set(0, bore + 0.006, -0.82);
  b.ejection.position.set(0.03, bore - 0.03, -0.06);
  b.ejection.rotation.z = -0.5;
  b.supportGrip.position.set(0, bore - 0.062, -0.4);
  b.cycleTravel = 0.06;
}

/** The M7 stand-in: the carbine's shape with a suppressor on the end. */
function m7(b: Builder): void {
  m4a1(b);
  b.tube(gunMaterials.parkerized(), 0.02, -1, -0.82, 0.068);
  b.body();
  b.muzzle.position.z = -1;
}

const SHAPES: Readonly<Record<WeaponId, (b: Builder) => void>> = { m4a1, mp5, m24, m249, m7 };

/** Build the stand-in model for a weapon. */
export function buildFallbackGun(id: WeaponId): GunModel {
  const builder = new Builder();
  SHAPES[id](builder);
  return builder.finish();
}
