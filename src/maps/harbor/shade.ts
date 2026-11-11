import * as THREE from 'three/webgpu';
import { abs, clamp, diffuseColor, float, materialAO, max, mix, normalWorld, positionWorld, smoothstep, texture, vec2, vec3 } from 'three/tsl';
import type { World } from '../../world/types';
import { heightAboveStreet, type TslNode } from './grime';
import { CAFE, NET_STORE, PASSAGE } from './layout';
import { blurOpen, boxBlur, HEIGHT_FLOOR, HEIGHT_RANGE, SHADE_GRID, spreadMax, streetLevel, toByte } from './shade-grid';

/**
 * Street lighting baked in plan, once, from the collision world.
 *
 *   R  how much sky a point at street level sees
 *   G  sunlight thrown back by lit paving and lit walls near by
 *   B  height of the roof line beside the point
 *   A  how much sun the paving itself gets (dries it out)
 *
 * The sun is ten degrees up, so most streets are in shade all day. Sky light
 * alone leaves that shade the same strength from kerb to eaves; with this,
 * lanes darken toward the ground, eaves shade the wall under them and walls
 * near sunlit paving pick up its warmth.
 */
const { x0: X0, z0: Z0, cell: CELL, cols: COLS, rows: ROWS } = SHADE_GRID;

/** Roofed rooms and the passage: dark for real, not solid. */
const ROOMS: readonly (readonly [number, number, number, number])[] = [
  [CAFE.x0, CAFE.x1, CAFE.z0, CAFE.z1],
  [NET_STORE.x0, NET_STORE.x1, NET_STORE.z0, NET_STORE.z1],
  [PASSAGE.x0, PASSAGE.x1, CAFE.z0, CAFE.z1],
];

const AZIMUTHS = 8;
/** Elevations of the two rings of sky rays; each ring is weighted by the sine of its elevation. */
const RINGS = [0.44, 0.96] as const;
const SUN_HEIGHTS = [0.15, 1.5, 4] as const;
const REACH = 70;

export function createShadeMap(): THREE.DataTexture {
  const data = new Uint8Array(COLS * ROWS * 4);
  // Until the bake lands: open sky, no bounce, no roof line.
  for (let i = 0; i < COLS * ROWS; i++) data.set([255, 0, 0, 128], i * 4);
  const map = new THREE.DataTexture(data, COLS, ROWS, THREE.RGBAFormat);
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearFilter;
  map.generateMipmaps = false;
  map.needsUpdate = true;
  return map;
}

function skyRays(): { readonly direction: THREE.Vector3; readonly weight: number }[] {
  const rays = [{ direction: new THREE.Vector3(0, 1, 0), weight: 1 }];
  for (const elevation of RINGS) {
    for (let k = 0; k < AZIMUTHS; k++) {
      const azimuth = ((k + (elevation === RINGS[0] ? 0 : 0.5)) / AZIMUTHS) * Math.PI * 2;
      rays.push({
        direction: new THREE.Vector3(Math.cos(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.sin(azimuth) * Math.cos(elevation)),
        weight: Math.sin(elevation),
      });
    }
  }
  return rays;
}

/** Fills the shade map over a few frames once the collision world is built. */
export class ShadeBake {
  private row = 0;
  private readonly open = new Float32Array(COLS * ROWS);
  private readonly sunGround = new Float32Array(COLS * ROWS);
  private readonly sunAir = new Float32Array(COLS * ROWS);
  private readonly roof = new Float32Array(COLS * ROWS);
  private readonly solid = new Uint8Array(COLS * ROWS);
  private readonly rays = skyRays();
  private readonly origin = new THREE.Vector3();

  constructor(
    private readonly map: THREE.DataTexture,
    private readonly world: World,
    private readonly sun: THREE.Vector3,
  ) {}

  get done(): boolean {
    return this.row > ROWS;
  }

  /** Bakes rows until `budgetMs` has passed, then writes the texture after the last one. */
  step(budgetMs: number): void {
    if (this.done) return;
    const start = performance.now();
    while (this.row < ROWS && performance.now() - start < budgetMs) this.bakeRow(this.row++);
    if (this.row === ROWS) {
      this.write();
      this.row++;
    }
  }

  private bakeRow(row: number): void {
    const { world, origin } = this;
    const z = Z0 + (row + 0.5) * CELL;
    const totalWeight = this.rays.reduce((sum, ray) => sum + ray.weight, 0);
    for (let col = 0; col < COLS; col++) {
      const x = X0 + (col + 0.5) * CELL;
      const i = row * COLS + col;
      const street = streetLevel(x, z);
      const ground = world.groundHeight(x, z, street + 1, 3.2) ?? street;
      const top = world.groundHeight(x, z, 60, 70) ?? ground;
      const roofed = top > ground + 1.6;
      const room = ROOMS.some(([rx0, rx1, rz0, rz1]) => x > rx0 && x < rx1 && z > rz0 && z < rz1);
      if (roofed && !room) {
        this.solid[i] = 1;
        this.roof[i] = top;
        continue;
      }
      let seen = 0;
      origin.set(x, ground + 0.3, z);
      for (const ray of this.rays) if (!world.raycast(origin, ray.direction, REACH)) seen += ray.weight;
      this.open[i] = seen / totalWeight;
      const lit = SUN_HEIGHTS.map((height) => {
        origin.set(x, ground + height, z);
        return world.raycast(origin, this.sun, REACH * 2) ? 0 : 1;
      });
      this.sunGround[i] = lit[0]!;
      this.sunAir[i] = (lit[1]! + lit[2]!) / 2;
    }
  }

  private write(): void {
    const { solid, sun } = this;
    // A wall is sunlit where the air in front of it is and the next cell down-sun is solid.
    const flat = Math.hypot(sun.x, sun.z) || 1;
    const stepCol = Math.round(-sun.x / flat);
    const stepRow = Math.round(-sun.z / flat);
    const source = new Float32Array(COLS * ROWS);
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const i = row * COLS + col;
        if (solid[i]) continue;
        let wall = 0;
        for (const reach of [1, 2]) {
          const c = col + stepCol * reach;
          const r = row + stepRow * reach;
          if (c >= 0 && c < COLS && r >= 0 && r < ROWS && solid[r * COLS + c]) wall = 1;
        }
        source[i] = Math.min(1, this.sunGround[i]! * 0.3 + this.sunAir[i]! * wall);
      }
    }
    const open = boxBlur(blurOpen(this.open, solid, COLS, ROWS, 1, 1), COLS, ROWS, 1, 1);
    const bounce = blurOpen(source, solid, COLS, ROWS, 3, 2);
    const dry = blurOpen(this.sunGround, solid, COLS, ROWS, 1, 1);
    const roof = spreadMax(this.roof, COLS, ROWS, 3);
    const data = this.map.image.data as Uint8Array;
    for (let i = 0; i < COLS * ROWS; i++) {
      data[i * 4] = toByte(open[i]!);
      data[i * 4 + 1] = toByte(bounce[i]! * 2.2);
      data[i * 4 + 2] = roof[i]! > 0 ? toByte((roof[i]! - HEIGHT_FLOOR) / HEIGHT_RANGE) : 0;
      data[i * 4 + 3] = toByte(dry[i]!);
    }
    this.map.needsUpdate = true;
  }
}

/** What the shade map says about a fragment, ready to use in a surface shader. */
export interface ShadeTerms {
  /** 0 - 1 multiplier for sky and bounce light. */
  readonly ambient: TslNode;
  /** Warm light thrown back from sunlit stone, to multiply by the surface colour. */
  readonly bounce: TslNode;
  /** 0 on paving that never sees the sun, 1 where it bakes all afternoon. */
  readonly dry: TslNode;
  /** Sky seen from street level at this point in plan, before height opens it up. */
  readonly street: TslNode;
}

const BOUNCE_TINT = vec3(1, 0.6, 0.32);

export function shadeTerms(map: THREE.Texture): ShadeTerms {
  // Walls sit on the edge between street and building: step out along the normal to read the street.
  const plan = positionWorld.xz.add(normalWorld.xz.mul(0.7));
  const sample = texture(map, plan.sub(vec2(X0, Z0)).div(vec2(COLS * CELL, ROWS * CELL)));
  const y = positionWorld.y;
  const ground = y.sub(heightAboveStreet);
  const roof = sample.b.mul(HEIGHT_RANGE).add(HEIGHT_FLOOR);
  const hasRoof = smoothstep(0.004, 0.02, sample.b);
  const rise = max(roof.sub(ground), 2.5);
  const up = clamp(heightAboveStreet.div(rise), 0, 1);
  const sky = mix(sample.r, float(1), up.mul(up));
  const upright = smoothstep(0.5, 0.8, abs(normalWorld.y)).oneMinus();
  const eave = smoothstep(roof.sub(1.5), roof.sub(0.05), y).mul(smoothstep(roof.add(0.1), roof.add(0.3), y).oneMinus()).mul(upright).mul(hasRoof);
  // The foot of a wall sees half a street of dark paving.
  const foot = smoothstep(0.0, 0.5, heightAboveStreet).oneMinus().mul(upright);
  const ambient = mix(float(0.24), float(1), sky).mul(mix(float(1), float(0.5), eave)).mul(mix(float(1), float(0.78), foot));
  const fade = mix(float(1), float(0.3), smoothstep(0.4, 7, heightAboveStreet));
  const level = mix(float(1), float(0.4), smoothstep(0.6, 0.9, normalWorld.y));
  return { ambient, bounce: BOUNCE_TINT.mul(sample.g.mul(fade).mul(level)), dry: sample.a, street: sample.r };
}

/** Applies street shade to a lit material. Call once its colour is final. */
export function shadeLit(material: THREE.MeshStandardNodeMaterial, terms: ShadeTerms, bounce = 0.55): void {
  material.aoNode = (material.aoMap ? (materialAO as TslNode) : float(1)).mul(terms.ambient);
  material.emissiveNode = (diffuseColor as TslNode).rgb.mul(terms.bounce).mul(bounce);
}
