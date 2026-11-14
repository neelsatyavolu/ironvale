// Records collision query fixtures by running the real TypeScript CollisionWorld. The Swift port
// replays the inputs and must reproduce every output (PLAN.md section 7, M2).
//
// queries.bin: "IVQ1", u32 version=1, u32 counts[raycast, los, ground, fits, paths],
//              u32 stepsPerPath, u32 sampleEvery, u32 segments, u32 0, u32 0   (48 bytes)
// then f64 records, all kinds in that order:
//   raycast (16): origin xyz, direction xyz (not normalised), maxDistance,
//                 hit 0|1, surface index | -1, point xyz, normal xyz, distance
//   los      (7): a xyz, b xyz, visible 0|1
//   ground   (6): x, z, fromY, maxDrop, hit 0|1, y
//   fits     (6): position xyz, radius, height, fits 0|1
//   path    (59): start xyz, radius, height, dt, segments * (vx, vz, jump 0|1),
//                 position xyz after every `sampleEvery`-th step (steps/sampleEvery samples),
//                 final velocity xyz, final onGround 0|1, final groundSurface index | -1
//
// Path driver, replayed exactly by Swift (IronvaleWorldTests/MapFixtureTests.swift): per step,
// segment s = floor(step / (steps / segments)); vel = (vx_s, vel.y - GRAVITY * dt, vz_s); on the
// first step of a jumping segment while grounded, vel.y = JUMP_SPEED; move; take position and
// velocity from the result; if grounded and vel.y < 0 then vel.y = 0.
import { Vector3 } from 'three/webgpu';
import { seededRandom, hashString } from '../../../../src/core/random';
import type { CollisionWorld } from '../../../../src/world/collision';
import type { MapInstance, Surface } from '../../../../src/world/types';
import { ByteWriter } from './io';
import { SURFACES } from './collision';

export const COUNTS = { raycast: 2500, los: 2000, ground: 2000, fits: 1500, paths: 2000 } as const;
export const STEPS = 120;
export const SAMPLE_EVERY = 10;
export const SEGMENTS = 4;
export const GRAVITY = 17.5;
export const JUMP_SPEED = 4.6;
const DTS = [1 / 60, 1 / 60, 1 / 120, 1 / 30, 0.05];
const HEIGHTS = [1.8, 1.8, 1.1];

const surfaceIndex = (surface: Surface | null): number => (surface ? SURFACES.indexOf(surface) : -1);

export function recordQueries(world: CollisionWorld, map: MapInstance, mapId: string): Uint8Array {
  const random = seededRandom(hashString(`${mapId}:collision-fixtures`));
  const range = (a: number, b: number) => a + (b - a) * random();
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  const play = map.bounds;
  const all = world.bounds;
  const top = all.max.y + 2;
  const drop = all.max.y - all.min.y + 4;

  /** A point over the playable area, 10 % past its edges. */
  const planar = () => {
    const mx = (play.max.x - play.min.x) * 0.1;
    const mz = (play.max.z - play.min.z) * 0.1;
    return [range(play.min.x - mx, play.max.x + mx), range(play.min.z - mz, play.max.z + mz)] as const;
  };
  /** Highest ground under a random point, or a random height in the playable box. */
  const standing = (lift: number) => {
    const [x, z] = planar();
    const ground = world.groundHeight(x, z, top, drop);
    const y = ground === null ? range(play.min.y, play.max.y) : ground + lift;
    return new Vector3(x, y, z);
  };
  /** Somewhere a body could be: on top, or on a lower floor found by a short drop. */
  const body = (lift: number) => {
    const p = standing(0);
    if (random() < 0.35) {
      const lower = world.groundHeight(p.x, p.z, range(play.min.y, play.max.y), range(1, 20));
      if (lower !== null) p.y = lower;
    }
    p.y += lift;
    return p;
  };
  const direction = () => {
    const d = new Vector3(range(-1, 1), range(-1, 1), range(-1, 1));
    if (random() < 0.2) d.set(range(-0.05, 0.05), -1, range(-0.05, 0.05));
    return d.multiplyScalar(range(0.25, 3));
  };

  const out = new ByteWriter();
  out.ascii('IVQ1');
  for (const n of [1, COUNTS.raycast, COUNTS.los, COUNTS.ground, COUNTS.fits, COUNTS.paths, STEPS, SAMPLE_EVERY, SEGMENTS, 0, 0]) {
    out.u32(n);
  }
  const f = (...values: number[]) => values.forEach((v) => out.f64(v));

  for (let i = 0; i < COUNTS.raycast; i++) {
    const origin = body(range(0.1, 3));
    const dir = direction();
    const max = range(2, 160);
    const hit = world.raycast(origin, dir, max);
    f(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, max);
    if (hit) f(1, surfaceIndex(hit.surface), hit.point.x, hit.point.y, hit.point.z, hit.normal.x, hit.normal.y, hit.normal.z, hit.distance);
    else f(0, -1, 0, 0, 0, 0, 0, 0, 0);
  }

  for (let i = 0; i < COUNTS.los; i++) {
    const a = body(range(0.5, 1.7));
    const b = random() < 0.5 ? body(range(0.5, 1.7)) : a.clone().add(direction().multiplyScalar(range(0.5, 10)));
    if (random() < 0.03) b.copy(a);
    f(a.x, a.y, a.z, b.x, b.y, b.z, world.lineOfSight(a, b) ? 1 : 0);
  }

  for (let i = 0; i < COUNTS.ground; i++) {
    const [x, z] = planar();
    const fromY = random() < 0.5 ? top : range(play.min.y, play.max.y + 5);
    const maxDrop = random() < 0.5 ? 50 : range(0.5, drop);
    const y = maxDrop === 50 ? world.groundHeight(x, z, fromY) : world.groundHeight(x, z, fromY, maxDrop);
    f(x, z, fromY, maxDrop, y === null ? 0 : 1, y ?? 0);
  }

  for (let i = 0; i < COUNTS.fits; i++) {
    const p = body(random() < 0.7 ? range(-0.05, 0.3) : range(0.3, 3));
    const radius = random() < 0.8 ? 0.34 : range(0.2, 0.6);
    const height = pick(HEIGHTS);
    f(p.x, p.y, p.z, radius, height, world.capsuleFits(p, radius, height) ? 1 : 0);
  }

  const perSegment = STEPS / SEGMENTS;
  for (let i = 0; i < COUNTS.paths; i++) {
    const start = body(range(0, 0.3));
    const radius = 0.34;
    const height = pick(HEIGHTS);
    const dt = pick(DTS);
    const segments = Array.from({ length: SEGMENTS }, () => {
      const heading = range(0, Math.PI * 2);
      const speed = random() < 0.1 ? 0 : range(1, random() < 0.2 ? 14 : 7);
      return [Math.cos(heading) * speed, Math.sin(heading) * speed, random() < 0.3 ? 1 : 0] as const;
    });
    f(start.x, start.y, start.z, radius, height, dt);
    for (const s of segments) f(s[0], s[1], s[2]);

    let pos = start.clone();
    let vel = new Vector3();
    let onGround = false;
    let surface: Surface | null = null;
    for (let step = 0; step < STEPS; step++) {
      const [vx, vz, jump] = segments[Math.floor(step / perSegment)];
      vel = new Vector3(vx, vel.y - GRAVITY * dt, vz);
      if (jump === 1 && step % perSegment === 0 && onGround) vel.y = JUMP_SPEED;
      const result = world.moveCapsule(pos, vel, dt, radius, height);
      pos = result.position;
      vel = result.velocity;
      onGround = result.onGround;
      surface = result.groundSurface;
      if (onGround && vel.y < 0) vel.y = 0;
      if ((step + 1) % SAMPLE_EVERY === 0) f(pos.x, pos.y, pos.z);
    }
    f(vel.x, vel.y, vel.z, onGround ? 1 : 0, surfaceIndex(surface));
  }
  return out.finish();
}
