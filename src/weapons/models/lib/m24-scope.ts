/**
 * The M24's day scope, built in code around the optical axis of the source
 * mesh's two lens discs: a 10x-class fixed-power tube with a 40 mm objective,
 * elevation, windage and focus knobs with knurled caps and engraved scales, a
 * rubber eyecup, a blacked interior with cross wires, and two split rings
 * clamped to the rail. Coordinates are the processed mesh's (metres, barrel
 * along -Z); the profiles run from the objective back to the eyepiece.
 */
import type * as THREE from 'three/webgpu';
import { block, emptyBins, knurled, place, turned, withUv, type PartBins, type ProfilePoint, type Vec3 } from './m24-shapes';

export interface ScopeSpec {
  /** Height of the optical axis above the mesh origin. */
  readonly axisY: number;
  /** Where the source lens discs sit along the bore. */
  readonly objectiveZ: number;
  readonly ocularZ: number;
  /** Top of the receiver rail. */
  readonly railTop: number;
}

const TUBE = 0.015;
const BELL = 0.0228;
const EYEPIECE = 0.0205;
const SADDLE = { front: -0.166, back: -0.121, radius: 0.0185 };
const RING = { centres: [-0.196, -0.092], width: 0.014, outer: 0.0192 };
const KNOB_SEAT = 0.0175;
const BODY_SEGMENTS = 48;

/** Outside of the tube from the objective lip to the back of the eyepiece, then in to the ocular seat. */
function bodyProfile(spec: ScopeSpec): ProfilePoint[] {
  const front = spec.objectiveZ;
  return [
    // Retaining ring ahead of the objective lens, then the sunshade bore out to the lip.
    [front - 0.0006, 0.0172],
    [front - 0.0034, 0.0172],
    [front - 0.0034, 0.0203],
    [front - 0.0194, 0.0203],
    [front - 0.0194, BELL],
    [front - 0.0149, BELL],
    [front - 0.0149, 0.0222],
    [front - 0.0134, 0.0222],
    [front - 0.0134, BELL],
    [front + 0.0236, BELL],
    [front + 0.0336, 0.0214, true],
    [front + 0.0436, 0.0186, true],
    [front + 0.0536, 0.0161, true],
    [front + 0.0616, TUBE],
    [SADDLE.front, TUBE],
    [SADDLE.front, SADDLE.radius],
    [SADDLE.back, SADDLE.radius],
    [SADDLE.back, TUBE],
    [-0.06, TUBE],
    [-0.053, 0.0186],
    [-0.0375, 0.0186],
    [-0.0375, EYEPIECE],
    [-0.012, EYEPIECE],
    [-0.012, 0.0198],
    [-0.0105, 0.0198],
    [-0.0105, EYEPIECE],
    [0, EYEPIECE],
    [0, 0.0214],
    [spec.ocularZ + 0.0011, 0.0214],
    [spec.ocularZ + 0.0011, 0.0184],
  ];
}

/** A dial's scale: an open band whose uv counts graduations (see `engraving`). */
function scale(z0: number, z1: number, radius: number, graduations: number): THREE.BufferGeometry {
  const geometry = turned([[z0, radius], [z1, radius]], { segments: 48, chamfer: 0 });
  const uv = geometry.attributes.uv;
  for (let index = 0; index < uv.count; index++) uv.setXY(index, uv.getX(index) * graduations, uv.getY(index) > 0 ? 0 : 1);
  return geometry;
}

/** A solid white index mark. */
function index(size: Vec3, at: Vec3): THREE.BufferGeometry {
  return place(withUv(block(size, 0), 0.5, 0.3), at);
}

/** An adjustment knob standing on the saddle along `axis`, built up its own +Z. */
function knob(bins: PartBins, seat: Vec3, axis: Vec3, radius: number, height: number, graduations: number): void {
  const capStart = 0.0095;
  const top = capStart + height;
  const post = turned(
    [
      [0, radius - 0.0024],
      [0.0035, radius - 0.0024],
      [0.0035, radius - 0.001],
      [0.0085, radius - 0.001],
      [0.0085, radius - 0.002],
      [capStart, radius - 0.002],
    ],
    { segments: 40 },
  );
  const cap = knurled(capStart, top, radius, 0.0007, Math.round(radius * 2400));
  const lid = turned(
    [
      [top, radius - 0.0006],
      [top + 0.0014, radius - 0.0006],
      [top + 0.0014, 0.0034],
      [top + 0.0006, 0.0034],
      [top + 0.0006, 0],
    ],
    { segments: 40 },
  );
  const screw = turned([[top + 0.0006, 0.0026], [top + 0.0015, 0.0026], [top + 0.0015, 0]], { segments: 6, faceted: true, chamfer: 0.0002 });
  bins.black.push(place(post, seat, axis), place(cap, seat, axis), place(lid, seat, axis));
  bins.steel.push(place(screw, seat, axis));
  bins.marks.push(place(scale(0.004, 0.0082, radius - 0.00095, graduations), seat, axis));
}

/** A socket-head cap screw standing along `axis`. */
export function capScrew(at: Vec3, axis: Vec3, radius = 0.0021): THREE.BufferGeometry {
  const height = radius * 0.7;
  return place(
    turned([[0, radius], [height, radius], [height, radius * 0.55], [height * 0.4, radius * 0.55], [height * 0.4, 0]], { segments: 12, chamfer: 0.00015 }),
    at,
    axis,
  );
}

function ring(bins: PartBins, spec: ScopeSpec, z: number): void {
  const half = RING.width / 2;
  bins.black.push(
    place(turned([[z - half, TUBE], [z - half, RING.outer], [z + half, RING.outer], [z + half, TUBE]], { segments: 40 }), [0, spec.axisY, 0]),
    // Clamp on the rail and the neck up to the ring.
    place(block([0.029, 0.0095, RING.width], 0.0007), [0, spec.railTop - 0.0018, z]),
    place(block([0.016, 0.011, RING.width - 0.002], 0.0006), [0, spec.axisY - RING.outer + 0.0015, z]),
  );
  for (const side of [-1, 1]) {
    const x = side * (RING.outer + 0.0027);
    // The ring is split at the tube's centre line: a lug on each half, pulled together by two screws.
    for (const lift of [-1, 1]) bins.black.push(place(block([0.0066, 0.005, RING.width], 0.0005), [x, spec.axisY + lift * 0.0029, z]));
    for (const along of [-1, 1]) bins.steel.push(capScrew([x, spec.axisY + 0.0053, z + along * 0.0036], [0, 1, 0]));
  }
  // Cross bolt through the rail clamp: a hex nut on the left, the bolt's head on the right.
  bins.steel.push(
    place(turned([[0, 0.0046], [0.004, 0.0046], [0.004, 0]], { segments: 6, faceted: true, chamfer: 0.0003 }), [-0.0143, spec.railTop - 0.0024, z], [-1, 0, 0]),
    place(turned([[0, 0.0027], [0.0014, 0.0027], [0.0014, 0]], { segments: 14, chamfer: 0.0003 }), [0.0143, spec.railTop - 0.0024, z], [1, 0, 0]),
  );
}

export function scopeParts(spec: ScopeSpec): PartBins {
  const bins = emptyBins();
  const onAxis = (geometry: THREE.BufferGeometry): THREE.BufferGeometry => place(geometry, [0, spec.axisY, 0]);
  const rear = spec.ocularZ;
  const mid = (SADDLE.front + SADDLE.back) / 2;

  bins.black.push(onAxis(turned(bodyProfile(spec), { segments: BODY_SEGMENTS })));
  // Power ring ahead of the eyepiece, and its scale.
  bins.black.push(onAxis(knurled(-0.0515, -0.0395, 0.02, 0.0008, 40)));
  bins.marks.push(onAxis(scale(-0.0368, -0.0335, EYEPIECE + 0.00006, 30)));
  bins.marks.push(index([0.0009, 0.0004, 0.003], [0, spec.axisY + 0.0186, -0.0545]));

  // Rubber eyecup behind the lock ring; its lip holds the ocular lens.
  bins.matte.push(
    onAxis(
      turned(
        [
          [rear - 0.0004, 0.0212],
          [rear - 0.0004, 0.0221],
          [rear + 0.0086, 0.0221],
          [rear + 0.0086, 0.0188],
          [rear + 0.0003, 0.0188],
          [rear + 0.0003, 0.0172],
        ],
        { segments: 40, chamfer: 0.0007 },
      ),
    ),
    // Inside of the tube, lens to lens, so neither end looks into a hollow gun.
    onAxis(
      turned(
        [
          [rear, 0.0172],
          [-0.035, 0.0172],
          [-0.058, 0.013],
          [spec.objectiveZ + 0.0616, 0.013],
          [spec.objectiveZ + 0.0236, 0.0172],
          [spec.objectiveZ - 0.0006, 0.0172],
        ],
        { segments: 24, chamfer: 0 },
      ),
    ),
    // Reticle wires at the focal plane.
    place(block([0.026, 0.00035, 0.00035], 0), [0, spec.axisY, -0.08]),
    place(block([0.00035, 0.026, 0.00035], 0), [0, spec.axisY, -0.08]),
  );

  knob(bins, [0, spec.axisY + KNOB_SEAT, mid], [0, 1, 0], 0.0132, 0.0095, 48);
  knob(bins, [KNOB_SEAT, spec.axisY, mid], [1, 0, 0], 0.0132, 0.0095, 48);
  knob(bins, [-KNOB_SEAT, spec.axisY, mid], [-1, 0, 0], 0.0142, 0.0065, 30);
  // Index lines on the saddle, facing the shooter.
  bins.marks.push(index([0.0008, 0.003, 0.0004], [0, spec.axisY + KNOB_SEAT + 0.0017, mid + 0.0108]));
  bins.marks.push(index([0.003, 0.0008, 0.0004], [KNOB_SEAT + 0.0017, spec.axisY, mid + 0.0108]));

  for (const z of RING.centres) ring(bins, spec, z);
  // Rail screws on the lengths of rail the rings leave bare.
  for (const z of [-0.0725, -0.2285]) bins.steel.push(capScrew([0, spec.railTop - 0.0006, z], [0, 1, 0], 0.0026));
  return bins;
}
