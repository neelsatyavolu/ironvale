/**
 * Fittings the M24's source mesh lacks, built in code: a folded bipod on the
 * fore-end stud, the rear sling swivel, the front sight base and thread
 * protector on the barrel, and a dark bore at the crown. Coordinates are the
 * processed mesh's (metres, barrel along -Z, bore on x = 0).
 */
import * as THREE from 'three/webgpu';
import { block, emptyBins, knurled, place, plain, turned, type PartBins, type ProfilePoint, type Vec3 } from './m24-shapes';
import { capScrew } from './m24-scope';

export interface FurnitureSpec {
  /** Bore axis height and the crown's place along it. */
  readonly bore: { readonly y: number; readonly muzzleZ: number };
  /** Barrel radius at the crown. */
  readonly muzzleRadius: number;
  /** Underside of the fore-end where the bipod clamps on, and of the butt at the rear swivel. */
  readonly bipodAt: Vec3;
  readonly swivelAt: Vec3;
}

const LEG = { outer: 0.0056, inner: 0.0043, sleeve: 0.1, collar: 0.008, reach: 0.165, foot: 0.018 };
const SPRING = { from: 0.008, to: 0.086, pitch: 0.0016, radius: 0.0017, wire: 0.0006, lift: 0.0083 };

/** A coil spring along +Z, drawn as a turned zig-zag. */
function spring(): THREE.BufferGeometry {
  const profile: ProfilePoint[] = [[SPRING.from, 0]];
  const turns = Math.round((SPRING.to - SPRING.from) / SPRING.pitch);
  for (let turn = 0; turn <= turns; turn++) {
    const z = SPRING.from + turn * SPRING.pitch;
    profile.push([z, SPRING.radius - SPRING.wire], [z + SPRING.pitch / 2, SPRING.radius]);
  }
  profile.push([SPRING.to + SPRING.pitch, 0]);
  return turned(profile, { segments: 6, chamfer: 0 });
}

/** Harris-pattern bipod, legs folded forward under the barrel. */
function bipod(bins: PartBins, at: Vec3): void {
  const [x0, y0, z0] = at;
  bins.black.push(
    // Body clamped up against the stock, and the knurled wheel that tightens it on the stud.
    place(block([0.03, 0.011, 0.044], 0.0008), [x0, y0 - 0.0052, z0]),
    place(knurled(0, 0.0052, 0.0076, 0.0006, 20), [x0, y0 - 0.0105, z0 + 0.011], [0, -1, 0]),
  );
  for (const side of [-1, 1]) {
    const pivot: Vec3 = [x0 + side * 0.0195, y0 - 0.0075, z0 - 0.015];
    // Folded legs lie tucked under the fore-end, rising a little with it.
    const along: Vec3 = [0, 0.03, -1];
    const above: Vec3 = [pivot[0], pivot[1] + SPRING.lift, pivot[2]];
    const end = LEG.sleeve + LEG.collar;
    bins.black.push(
      place(block([0.0075, 0.017, 0.02], 0.0006), [x0 + side * 0.0165, y0 - 0.0085, z0 - 0.011]),
      place(turned([[0, 0], [0, LEG.outer], [LEG.sleeve, LEG.outer], [LEG.sleeve, 0]], { segments: 16 }), pivot, along),
      place(knurled(LEG.sleeve, end, LEG.outer + 0.001, 0.0006, 16), pivot, along),
      place(turned([[end, LEG.inner], [LEG.reach, LEG.inner]], { segments: 14, chamfer: 0 }), pivot, along),
      // Posts the spring hooks on.
      place(block([0.003, 0.006, 0.003], 0.0004), [above[0], above[1] - 0.003, above[2] - SPRING.from]),
      place(block([0.003, 0.006, 0.003], 0.0004), [above[0], above[1] + 0.03 * SPRING.to - 0.003, above[2] - SPRING.to]),
    );
    bins.matte.push(
      place(
        turned([[LEG.reach - 0.002, LEG.inner], [LEG.reach - 0.002, 0.0062], [LEG.reach + LEG.foot, 0.0062], [LEG.reach + LEG.foot, 0]], { segments: 14, chamfer: 0.001 }),
        pivot,
        along,
      ),
    );
    bins.steel.push(
      place(spring(), above, along),
      // Hinge pin head.
      place(turned([[0, 0.003], [0.0015, 0.003], [0.0015, 0]], { segments: 12, chamfer: 0.0003 }), [x0 + side * 0.0202, y0 - 0.0075, z0 - 0.015], [side, 0, 0]),
    );
  }
}

/** Sling stud under the butt with a loop hanging from it. */
function swivel(bins: PartBins, at: Vec3): void {
  bins.black.push(place(turned([[0, 0.0046], [0.003, 0.0046], [0.003, 0.003], [0.009, 0.003], [0.009, 0]], { segments: 14 }), [at[0], at[1] + 0.001, at[2]], [0, -1, 0]));
  const loop = plain(new THREE.TorusGeometry(0.0095, 0.0016, 6, 22));
  loop.scale(1, 0.82, 1);
  loop.rotateX(0.45);
  loop.translate(at[0], at[1] - 0.0128, at[2] + 0.0035);
  bins.steel.push(loop);
}

function barrelFittings(bins: PartBins, spec: FurnitureSpec): void {
  const { y, muzzleZ } = spec.bore;
  const r = spec.muzzleRadius;
  const onBore = (geometry: THREE.BufferGeometry): THREE.BufferGeometry => place(geometry, [0, y, 0]);
  // Thread protector, a hair short of the crown so the crown stays the foremost point of the steel.
  const front = muzzleZ + 0.0002;
  bins.black.push(
    onBore(
      turned(
        [
          [front, r - 0.0003],
          [front, r + 0.0016],
          [front + 0.006, r + 0.0016],
          [front + 0.006, r + 0.0009],
          [front + 0.0075, r + 0.0009],
          [front + 0.0075, r + 0.0016],
          [front + 0.012, r + 0.0016],
          [front + 0.012, r + 0.0009],
          [front + 0.0135, r + 0.0009],
          [front + 0.0135, r + 0.0016],
          [front + 0.02, r + 0.0016],
          [front + 0.02, r],
        ],
        { segments: 36 },
      ),
    ),
    // Front sight base, left on the barrel for iron sights.
    place(block([0.011, 0.005, 0.032], 0.0008), [0, y + r + 0.0022, muzzleZ + 0.046]),
  );
  for (const z of [muzzleZ + 0.037, muzzleZ + 0.055]) bins.steel.push(capScrew([0, y + r + 0.0045, z], [0, 1, 0], 0.0019));
  // The bore, drawn as a black disc just proud of the crown.
  bins.matte.push(onBore(turned([[muzzleZ - 0.0002, 0], [muzzleZ - 0.0002, 0.0039]], { segments: 20, chamfer: 0 })));
}

export function furnitureParts(spec: FurnitureSpec): PartBins {
  const bins = emptyBins();
  bipod(bins, spec.bipodAt);
  swivel(bins, spec.swivelAt);
  barrelFittings(bins, spec);
  return bins;
}
