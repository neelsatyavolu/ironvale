import * as THREE from 'three/webgpu';
import {
  attribute,
  float,
  mix,
  mx_noise_float,
  normalMap,
  positionWorld,
  smoothstep,
  texture,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import type { PbrMaps } from '../../core/assets';
import type { Surface, World } from '../../world/types';
import { CELL, FIELD, PLAY, WALL_OFFSET, surfaceAt, terrainPaint, type Heightfield } from './layout';

/** TSL graphs are loosely typed upstream; keep that looseness inside this file. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TslNode = any;

const COLLIDER_MARGIN = 7;
const WALL_HEIGHT = 26;

/** Visible terrain: one grid mesh whose vertices carry paint weights for trail, creek and yard. */
export function buildTerrainMesh(field: Heightfield, ground: PbrMaps, trail: PbrMaps): THREE.Mesh {
  const { columns, rows } = field;
  const count = columns * rows;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const paint = new Float32Array(count * 3);
  const n = new THREE.Vector3();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const i = r * columns + c;
      const x = FIELD.minX + c * CELL;
      const z = FIELD.minZ + r * CELL;
      position.set([x, field.at(c, r), z], i * 3);
      n.set(field.at(c - 1, r) - field.at(c + 1, r), 2 * CELL, field.at(c, r - 1) - field.at(c, r + 1)).normalize();
      normal.set([n.x, n.y, n.z], i * 3);
      // Metres, with V flipped so the tangent frame stays right-handed.
      uvs.set([x, -z], i * 2);
      paint.set(terrainPaint(x, z), i * 3);
    }
  }
  const index = new Uint32Array((columns - 1) * (rows - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < columns - 1; c++) {
      const a = r * columns + c;
      const b = a + 1;
      const d = a + columns;
      index.set([a, d, b, b, d, d + 1], k);
      k += 6;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('paint', new THREE.BufferAttribute(paint, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));

  const mesh = new THREE.Mesh(geometry, terrainMaterial(ground, trail));
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}

/**
 * Forest floor blended with trail dirt and creek gravel. The floor is sampled
 * at two scales and tinted by large noise so no repeat is readable.
 */
function terrainMaterial(ground: PbrMaps, trail: PbrMaps): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  const metres: TslNode = uv();
  const world: TslNode = positionWorld.xz;
  const paint: TslNode = attribute('paint', 'vec3');

  const edgeNoise: TslNode = mx_noise_float(world.mul(1.3)).mul(0.5).add(0.5);
  const macro: TslNode = mx_noise_float(world.mul(0.085)).mul(0.5).add(0.5);
  const patch: TslNode = mx_noise_float(world.mul(0.31).add(vec2(17.3, 4.1))).mul(0.5).add(0.5);
  const sharpen = (weight: TslNode): TslNode => smoothstep(0.3, 0.7, weight.add(edgeNoise.sub(0.5).mul(0.45)));
  const trailW: TslNode = sharpen(paint.x);
  const creekW: TslNode = sharpen(paint.y);
  const yardW: TslNode = sharpen(paint.z).mul(0.85);
  const bare: TslNode = trailW.max(yardW);

  const groundUv: TslNode = metres.div(3);
  const groundFarUv: TslNode = metres.div(11.3).add(vec2(0.37, 0.61));
  const trailUv: TslNode = metres.div(2.7);
  const gravelUv: TslNode = metres.div(3.6).add(vec2(0.2, 0.7));

  // Colour.
  const near: TslNode = texture(ground.color, groundUv).rgb;
  const far: TslNode = texture(ground.color, groundFarUv).rgb;
  let floor: TslNode = mix(near, far, macro.mul(0.6).add(0.15));
  floor = floor.mul(mix(vec3(0.5, 0.52, 0.46), vec3(0.78, 0.72, 0.6), macro));
  // Drifts of dead needles under the trees: the brown that makes a conifer floor.
  const drift: TslNode = mx_noise_float(world.mul(0.17).add(vec2(5.1, 31.7))).mul(0.5).add(0.5);
  const litter: TslNode = smoothstep(0.38, 0.62, drift.add(edgeNoise.sub(0.5).mul(0.25)));
  const floorLuma: TslNode = floor.r.mul(0.3).add(floor.g.mul(0.6)).add(floor.b.mul(0.1));
  floor = mix(floor, vec3(0.36, 0.25, 0.15).mul(floorLuma.mul(2.4).add(0.05)), litter.mul(0.55));
  // Moss carpets in irregular patches.
  const moss: TslNode = smoothstep(0.58, 0.76, patch.add(edgeNoise.mul(0.18)));
  const luma: TslNode = floor.r.mul(0.3).add(floor.g.mul(0.6)).add(floor.b.mul(0.1));
  floor = mix(floor, vec3(0.17, 0.25, 0.08).mul(luma.mul(2.8).add(0.1)), moss.mul(0.6));
  const dirt: TslNode = texture(trail.color, trailUv).rgb.mul(vec3(0.5, 0.47, 0.42));
  const gravel: TslNode = texture(trail.color, gravelUv).rgb.mul(vec3(0.45, 0.45, 0.46));
  // The creek's centre line stays damp and dark.
  const damp: TslNode = smoothstep(0.75, 1.0, paint.y).mul(patch.mul(0.6).add(0.4));
  let color: TslNode = mix(floor, dirt, bare);
  color = mix(color, gravel.mul(mix(float(1), float(0.62), damp)), creekW);
  material.colorNode = color;

  // Normal, roughness and occlusion follow the same weights.
  const stony: TslNode = bare.max(creekW);
  const groundNormal: TslNode = texture(ground.normal as THREE.Texture, groundUv).rgb;
  const trailNormal: TslNode = mix(
    texture(trail.normal as THREE.Texture, trailUv).rgb,
    texture(trail.normal as THREE.Texture, gravelUv).rgb,
    creekW,
  );
  material.normalNode = normalMap(mix(groundNormal, trailNormal, stony), vec2(1.15, 1.15));
  const groundArm: TslNode = texture(ground.arm as THREE.Texture, groundUv);
  const trailArm: TslNode = texture(trail.arm as THREE.Texture, trailUv);
  // Kept rough even where damp: a low sun on a smoother bed blows out to white.
  material.roughnessNode = mix(groundArm.g, trailArm.g.mul(0.96), stony).mul(mix(float(1), float(0.94), damp.mul(creekW)));
  material.aoNode = mix(groundArm.r, trailArm.r, stony);
  return material;
}

/** Terrain collision, split by surface kind so footsteps and impacts match what is underfoot. */
export function addTerrainColliders(field: Heightfield, world: World): void {
  const c0 = Math.round((PLAY.minX - COLLIDER_MARGIN - FIELD.minX) / CELL);
  const c1 = Math.round((PLAY.maxX + COLLIDER_MARGIN - FIELD.minX) / CELL);
  const r0 = Math.round((PLAY.minZ - COLLIDER_MARGIN - FIELD.minZ) / CELL);
  const r1 = Math.round((PLAY.maxZ + COLLIDER_MARGIN - FIELD.minZ) / CELL);
  const triangles = new Map<Surface, number[]>();
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      const x = FIELD.minX + c * CELL;
      const z = FIELD.minZ + r * CELL;
      const surface = surfaceAt(x + CELL / 2, z + CELL / 2);
      const list = triangles.get(surface) ?? [];
      if (!triangles.has(surface)) triangles.set(surface, list);
      const h00 = field.at(c, r);
      const h10 = field.at(c + 1, r);
      const h01 = field.at(c, r + 1);
      const h11 = field.at(c + 1, r + 1);
      list.push(x, h00, z, x, h01, z + CELL, x + CELL, h10, z);
      list.push(x + CELL, h10, z, x, h01, z + CELL, x + CELL, h11, z + CELL);
    }
  }
  const identity = new THREE.Matrix4();
  for (const [surface, list] of triangles) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(list), 3));
    world.addCollider(geometry, identity, surface);
    geometry.dispose();
  }
}

/**
 * Invisible walls buried in the foot of the boundary bank. Tagged as foliage so
 * a shot into the tree line sounds like brush rather than stone.
 */
export function addBoundaryWalls(world: World): void {
  const minX = PLAY.minX - WALL_OFFSET;
  const maxX = PLAY.maxX + WALL_OFFSET;
  const minZ = PLAY.minZ - WALL_OFFSET;
  const maxZ = PLAY.maxZ + WALL_OFFSET;
  const spanX = maxX - minX + 2;
  const spanZ = maxZ - minZ + 2;
  const walls: readonly (readonly [number, number, number, number])[] = [
    [spanX, 1, (minX + maxX) / 2, minZ - 0.5],
    [spanX, 1, (minX + maxX) / 2, maxZ + 0.5],
    [1, spanZ, minX - 0.5, (minZ + maxZ) / 2],
    [1, spanZ, maxX + 0.5, (minZ + maxZ) / 2],
  ];
  for (const [width, depth, x, z] of walls) {
    const geometry = new THREE.BoxGeometry(width, WALL_HEIGHT, depth);
    world.addCollider(geometry, new THREE.Matrix4().makeTranslation(x, WALL_HEIGHT / 2 - 4, z), 'foliage');
    geometry.dispose();
  }
}
