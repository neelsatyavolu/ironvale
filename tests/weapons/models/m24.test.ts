import * as THREE from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GunModel } from '../../../src/game/contracts';
import m24, { M24_BORE } from '../../../src/weapons/models/m24.gun';
import { centroid, loadGunFile, surfacePoints, withMaterial, worldAxis, worldPoint, worldVertices, type GunFile } from './m1garand-m24.fixture';

const MM = 0.001;

describe('m24.glb', () => {
  let file: GunFile;
  beforeAll(async () => {
    file = await loadGunFile('m24.glb', 'mdl-gun-m24');
  });

  it('is small and uses only formats the loader can decode', () => {
    expect(file.bytes).toBeLessThan(1_000_000);
    expect(file.triangles).toBeGreaterThan(9_000);
    expect(file.triangles).toBeLessThan(12_000);
    expect(file.extensions).toEqual(['EXT_texture_webp']);
    expect(new Set(file.textureTypes)).toEqual(new Set(['image/webp']));
    expect(file.textureSizes.length).toBeLessThanOrEqual(5);
    expect(Math.max(...file.textureSizes)).toBeLessThanOrEqual(1024);
  });

  it('keeps the fixed parts in one node and the moving parts and lenses in their own', () => {
    const nodes = file.document.getRoot().listNodes();
    expect(nodes.map((node) => node.getName()).sort()).toEqual(
      ['body', 'bolt', 'bolt_body', 'bolt_handle', 'lens_objective', 'lens_ocular', 'trigger'].sort(),
    );
    const body = nodes.find((node) => node.getName() === 'body')?.getMesh();
    // One draw call per material for everything that does not move.
    expect(body?.listPrimitives().map((prim) => prim.getMaterial()?.getName()).sort()).toEqual(['guard', 'metal', 'rubber', 'stock']);
  });
});

describe('m24 gun module', () => {
  let file: GunFile;
  let model: GunModel;
  let bounds: THREE.Box3;
  let metal: THREE.Vector3[];
  let stock: THREE.Vector3[];
  beforeAll(async () => {
    file = await loadGunFile('m24.glb', 'mdl-gun-m24');
    model = m24.build(file.assets);
    model.root.updateMatrixWorld(true);
    bounds = new THREE.Box3().setFromObject(model.root, true);
    metal = surfacePoints(model.root, withMaterial('metal'), 4);
    stock = surfacePoints(model.root, withMaterial('stock'));
  });

  it('declares its weapon and asset', () => {
    expect(m24.weaponId).toBe('m24');
    expect(m24.assets).toEqual(['mdl-gun-m24']);
  });

  it('is 43 inches long with the barrel along -Z and the origin at the wrist', () => {
    const size = bounds.getSize(new THREE.Vector3());
    expect(size.z).toBeCloseTo(1.092, 2);
    expect(size.x).toBeLessThan(0.09);
    expect(size.y).toBeLessThan(0.26);
    expect(-bounds.min.z).toBeGreaterThan(0.7);
    expect(bounds.max.z).toBeGreaterThan(0.25);
    // The wrist of the stock surrounds the origin.
    const wrist = stock.filter((point) => Math.abs(point.z) < 0.02);
    expect(Math.min(...wrist.map((point) => point.y))).toBeLessThan(-0.02);
    expect(Math.max(...wrist.map((point) => point.y))).toBeGreaterThan(0.02);
  });

  it('has a stock wider than the action, as on the real rifle', () => {
    const foreEnd = stock.filter((point) => point.z < -0.2 && point.z > -0.4);
    const width = Math.max(...foreEnd.map((point) => point.x)) - Math.min(...foreEnd.map((point) => point.x));
    expect(width).toBeGreaterThan(0.038);
    expect(width).toBeLessThan(0.052);
  });

  it('puts the muzzle anchor on the crown, on the bore axis', () => {
    const muzzle = worldPoint(model.muzzle);
    // Nothing reaches further forward than the crown.
    expect(muzzle.z - bounds.min.z).toBeLessThan(1 * MM);
    expect(muzzle.z - bounds.min.z).toBeGreaterThanOrEqual(-0.2 * MM);
    const crown = metal.filter((point) => point.z < bounds.min.z + 0.5 * MM);
    expect(crown.length).toBeGreaterThan(12);
    const centre = new THREE.Box3().setFromPoints(crown).getCenter(new THREE.Vector3());
    expect(Math.hypot(centre.x - muzzle.x, centre.y - muzzle.y)).toBeLessThan(1 * MM);
    // The bore runs straight down -Z: the barrel a hand's length back is centred on the same axis.
    const ring = metal.filter((point) => point.z < -0.6 && point.z > -0.7 && Math.hypot(point.x, point.y - M24_BORE.y) < 0.02);
    for (const point of ring) expect(Math.hypot(point.x - muzzle.x, point.y - muzzle.y)).toBeLessThan(13 * MM);
    expect(worldAxis(model.muzzle, new THREE.Vector3(0, 0, -1)).z).toBeCloseTo(-1, 6);
  });

  it('puts the eye on the optical axis of the scope, behind the eyepiece', () => {
    const ocular = model.root.getObjectByName('lens_ocular');
    const objective = model.root.getObjectByName('lens_objective');
    if (!ocular || !objective) throw new Error('lens nodes missing');
    const eye = worldPoint(model.sight);
    const rear = worldPoint(ocular);
    const front = worldPoint(objective);
    for (const point of [rear, front]) {
      expect(point.x).toBeCloseTo(eye.x, 5);
      expect(point.y).toBeCloseTo(eye.y, 5);
    }
    // Each lens origin really is the middle of its glass disc.
    for (const lens of [ocular, objective]) {
      const disc = new THREE.Box3().setFromObject(lens, true);
      const middle = disc.getCenter(new THREE.Vector3());
      expect(middle.distanceTo(worldPoint(lens))).toBeLessThan(0.2 * MM);
      expect(disc.max.x - disc.min.x).toBeGreaterThan(0.02);
      expect(disc.max.z - disc.min.z).toBeLessThan(0.5 * MM);
    }
    // The scope tube around the line of sight is centred on it.
    const tube = metal.filter((point) => point.z < rear.z - 0.03 && point.z > front.z + 0.03 && Math.hypot(point.x - eye.x, point.y - eye.y) < 0.016);
    expect(tube.length).toBeGreaterThan(50);
    const tubeCentre = new THREE.Box3().setFromPoints(tube.filter((point) => Math.abs(point.z - (rear.z - 0.05)) < 0.015)).getCenter(new THREE.Vector3());
    expect(Math.hypot(tubeCentre.x - eye.x, tubeCentre.y - eye.y)).toBeLessThan(1.5 * MM);
    expect(front.z).toBeLessThan(rear.z - 0.25);
    expect(eye.z - rear.z).toBeGreaterThan(0.07);
    expect(eye.z - rear.z).toBeLessThan(0.12);
    expect(eye.z).toBeLessThan(bounds.max.z - 0.1);
    expect(worldAxis(model.sight, new THREE.Vector3(0, 0, -1)).z).toBeCloseTo(-1, 9);
    expect(model.sight.parent).toBe(model.root);
    // Scope sits over the bore, parallel to it.
    expect(eye.x).toBeCloseTo(worldPoint(model.muzzle).x, 3);
    expect(eye.y - worldPoint(model.muzzle).y).toBeGreaterThan(0.035);
    expect(eye.y - worldPoint(model.muzzle).y).toBeLessThan(0.06);
  });

  it('gives the lenses their own glass material instead of the body finish', () => {
    const ocular = model.root.getObjectByName('lens_ocular') as THREE.Mesh;
    expect((ocular.material as THREE.Material).name).toMatch(/lens/);
    expect((ocular.material as THREE.Material).transparent).toBe(true);
  });

  it('exposes a turn bolt with its origin on the bolt axis', () => {
    const { bolt } = model.parts;
    if (!bolt) throw new Error('bolt missing');
    expect(bolt.name).toBe('bolt');
    expect(bolt.getObjectByName('bolt_handle')).toBeDefined();
    const axis = worldPoint(bolt);
    // The bolt body is a cylinder around the node's origin, on the bore axis.
    const body = worldVertices(bolt, withMaterial('bolt_steel'));
    const middle = centroid(body);
    expect(Math.hypot(middle.x - axis.x, middle.y - axis.y)).toBeLessThan(1 * MM);
    expect(Math.hypot(axis.x - worldPoint(model.muzzle).x, axis.y - worldPoint(model.muzzle).y)).toBeLessThan(1 * MM);
    // Handle sticks out to the right of the axis, so a positive roll about +Z lifts it.
    const handle = new THREE.Box3().setFromObject(bolt, true);
    expect(handle.max.x - axis.x).toBeGreaterThan(0.03);
    expect(axis.x - handle.min.x).toBeLessThan(0.015);
    expect(model.cycleTravel).toBeGreaterThan(0.07);
    expect(model.cycleTravel).toBeLessThan(0.12);
    // The firing hand is sent to the bolt's origin: it has to be level with the knob along the bore.
    const knob = worldVertices(bolt).filter((point) => point.x > handle.max.x - 2 * MM);
    expect(Math.abs(centroid(knob).z - axis.z)).toBeLessThan(8 * MM);
    // Pulled back, the bolt stays above the stock and short of the butt.
    bolt.position.z += model.cycleTravel;
    const open = new THREE.Box3().setFromObject(bolt, true);
    bolt.position.z -= model.cycleTravel;
    expect(open.max.z).toBeLessThan(bounds.max.z - 0.1);
    expect(open.max.z - handle.max.z).toBeCloseTo(model.cycleTravel, 4);
  });

  it('hangs the trigger from its pin inside the guard', () => {
    const { trigger } = model.parts;
    if (!trigger) throw new Error('trigger missing');
    const pin = worldPoint(trigger);
    const blade = new THREE.Box3().setFromObject(trigger, true);
    expect(blade.max.y).toBeLessThanOrEqual(pin.y + 1 * MM);
    expect(pin.y - blade.min.y).toBeGreaterThan(0.012);
    expect(Math.abs(blade.getCenter(new THREE.Vector3()).x)).toBeLessThan(1 * MM);
    const guard = new THREE.Box3().setFromPoints(worldVertices(model.root, withMaterial('guard')).filter((point) => point.y < pin.y));
    expect(blade.min.z).toBeGreaterThan(guard.min.z);
    expect(blade.max.z).toBeLessThan(guard.max.z);
    expect(blade.min.y).toBeGreaterThan(guard.min.y);
  });

  it('seats a box magazine ahead of the guard that drops out along its parent -Y', () => {
    const { magazine, trigger } = model.parts;
    if (!magazine || !trigger) throw new Error('parts missing');
    const box = new THREE.Box3().setFromObject(magazine, true);
    const well = stock.filter((point) => point.z > box.min.z && point.z < box.max.z);
    const stockBottom = Math.min(...well.map((point) => point.y));
    const stockHalfWidth = Math.max(...well.map((point) => Math.abs(point.x)));
    // Top hidden in the stock, a few centimetres showing below it, narrower than the stock.
    expect(box.max.y).toBeGreaterThan(stockBottom + 0.01);
    expect(stockBottom - box.min.y).toBeGreaterThan(0.025);
    expect(stockBottom - box.min.y).toBeLessThan(0.05);
    expect(box.max.x).toBeLessThan(stockHalfWidth);
    expect(box.max.x + box.min.x).toBeCloseTo(0, 4);
    expect(box.max.z).toBeLessThan(new THREE.Box3().setFromObject(trigger, true).min.z - 0.01);
    expect(box.max.y).toBeLessThan(worldPoint(model.muzzle).y - 0.01);
    const before = worldPoint(magazine);
    magazine.position.y -= 0.1;
    expect(worldPoint(magazine).y - before.y).toBeCloseTo(-0.1, 3);
    magazine.position.y += 0.1;
    // The collar stays behind and marks the well.
    const collar = model.root.getObjectByName('magwell');
    expect(collar).toBeDefined();
    expect(collar?.parent).not.toBe(magazine);
  });

  it('places the hands on the wrist and under the fore-end', () => {
    const palm = worldPoint(model.grips.trigger);
    const { trigger } = model.parts;
    if (!trigger) throw new Error('trigger missing');
    expect(palm.length()).toBeLessThan(0.05);
    // Right palm against the right side of the wrist, behind the trigger.
    const wrist = stock.filter((point) => Math.abs(point.z - palm.z) < 0.02 && Math.abs(point.y - palm.y) < 0.02);
    const side = Math.max(...wrist.map((point) => point.x));
    expect(Math.abs(palm.x - side)).toBeLessThan(6 * MM);
    expect(palm.z).toBeGreaterThan(new THREE.Box3().setFromObject(trigger, true).max.z + 0.03);
    // Fingers point forward and down, thumb side up.
    expect(worldAxis(model.grips.trigger, new THREE.Vector3(0, 0, -1)).z).toBeLessThan(-0.8);
    expect(worldAxis(model.grips.trigger, new THREE.Vector3(0, 1, 0)).y).toBeGreaterThan(0.8);

    const support = worldPoint(model.grips.support);
    const under = stock.filter((point) => Math.abs(point.z - support.z) < 0.03);
    expect(under.length).toBeGreaterThan(4);
    const bottom = Math.min(...under.map((point) => point.y));
    // Palm cupped just under the fore-end, ahead of the magazine and behind the tip of the stock.
    expect(support.y).toBeLessThan(bottom + 2 * MM);
    expect(bottom - support.y).toBeLessThan(0.02);
    expect(Math.abs(support.x)).toBeLessThan(0.02);
    expect(support.z).toBeLessThan(new THREE.Box3().setFromObject(model.parts.magazine as THREE.Object3D, true).min.z - 0.08);
    expect(support.z).toBeGreaterThan(Math.min(...stock.map((point) => point.z)) + 0.08);
    // Fingers wrap across to the right, palm facing up.
    expect(worldAxis(model.grips.support, new THREE.Vector3(0, 0, -1)).x).toBeGreaterThan(0.9);
    expect(worldAxis(model.grips.support, new THREE.Vector3(1, 0, 0)).y).toBeGreaterThan(0.5);
  });

  it('puts the ejection anchor in the port on the right of the receiver', () => {
    const port = worldPoint(model.ejection);
    const direction = worldAxis(model.ejection, new THREE.Vector3(1, 0, 0));
    expect(direction.x).toBeGreaterThan(0.5);
    expect(direction.y).toBeGreaterThan(0);
    const muzzle = worldPoint(model.muzzle);
    // On the right of the bore, at the height of the upper half of the bolt.
    expect(port.x).toBeGreaterThan(0.008);
    expect(port.x).toBeLessThan(0.018);
    expect(port.y - muzzle.y).toBeGreaterThan(0);
    expect(port.y - muzzle.y).toBeLessThan(0.012);
    // Along the bolt body, between its face and the handle.
    const bolt = model.parts.bolt as THREE.Object3D;
    const body = new THREE.Box3().setFromPoints(worldVertices(bolt, withMaterial('bolt_steel')));
    expect(port.z).toBeGreaterThan(body.min.z + 0.05);
    expect(port.z).toBeLessThan(body.max.z - 0.03);
    // The receiver wall is cut away there: no receiver vertices on the upper right between the port's ends.
    const wall = metal.filter(
      (point) => Math.abs(point.z - port.z) < 0.02 && point.x > 0.008 && point.y > muzzle.y + 2 * MM && point.y < muzzle.y + 0.012,
    );
    expect(wall.length).toBe(0);
  });

  it('builds cheap copies that share geometry and materials', () => {
    const other = m24.build(file.assets);
    const collect = (root: THREE.Object3D): { geometry: THREE.BufferGeometry[]; materials: THREE.Material[] } => {
      const geometry: THREE.BufferGeometry[] = [];
      const materials: THREE.Material[] = [];
      root.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        geometry.push(node.geometry);
        materials.push(node.material as THREE.Material);
      });
      return { geometry, materials };
    };
    const a = collect(model.root);
    const b = collect(other.root);
    expect(b.geometry).toEqual(a.geometry);
    b.materials.forEach((material, index) => expect(material).toBe(a.materials[index]));
    expect(other.root).not.toBe(model.root);
    expect(a.geometry.length).toBeLessThanOrEqual(12);
  });

  it('casts and receives shadows on every mesh, including the parts built in code', () => {
    model.root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      expect(node.castShadow).toBe(true);
      expect(node.receiveShadow).toBe(true);
    });
  });
});
