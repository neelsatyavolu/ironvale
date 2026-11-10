/**
 * Measured points of the guns-c models (M4A1, M249) and the pure maths that
 * turns them into anchor poses. Kept free of meshes so it can be unit tested.
 * All coordinates are gun space: metres, barrel along -Z, up +Y, origin at the
 * centre of the pistol grip.
 */
import { Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import type { GunModel } from '../../../game/contracts';

export type Triple = readonly [number, number, number];
export type PartName = keyof GunModel['parts'];

export interface GripSpec {
  /** Palm centre. */
  readonly position: Triple;
  /** Direction from the wrist toward the knuckles. */
  readonly fingers: Triple;
  /** Direction of the thumb side of the hand; squared up against `fingers`. */
  readonly thumb: Triple;
}

export interface GunLayout {
  /** Manifest id of the processed glTF. */
  readonly asset: string;
  /** Overall length of the real weapon in metres, for the scale check. */
  readonly realLength: number;
  /** Centre of the muzzle crown. */
  readonly muzzle: Triple;
  /** Mouth of the ejection port. */
  readonly ejection: Triple;
  /** Degrees the ejection direction is tilted up (negative: down) from straight out to the right. */
  readonly ejectionTiltDeg: number;
  /** Centre of the rear aperture, or of the optic's window. */
  readonly sightRear: Triple;
  /** Tip of the front post, or a point further down the optic's axis. */
  readonly sightFront: Triple;
  /** Distance from `sightRear` back to the eye. */
  readonly eyeRelief: number;
  /** glTF node name of each moving part. */
  readonly parts: Readonly<Partial<Record<PartName, string>>>;
  /** Travel in metres along +Z of the bolt when cycled. */
  readonly cycleTravel: number;
  readonly grips: { readonly trigger: GripSpec; readonly support: GripSpec };
}

export interface Pose {
  readonly position: Vector3;
  readonly quaternion: Quaternion;
}

/**
 * Where the eye sits to aim: on the line through both sights, `eyeRelief`
 * behind the rear one, looking along that line (local -Z).
 */
export function sightPose(layout: Pick<GunLayout, 'sightRear' | 'sightFront' | 'eyeRelief'>): Pose {
  const rear = new Vector3(...layout.sightRear);
  const front = new Vector3(...layout.sightFront);
  const direction = front.clone().sub(rear);
  if (direction.z >= 0) throw new Error('The front sight must be ahead of the rear sight (further down -Z)');
  direction.normalize();
  const position = rear.clone().addScaledVector(direction, -layout.eyeRelief);
  const quaternion = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(position, front, new Vector3(0, 1, 0)));
  return { position, quaternion };
}

/** Pose of a hand grip: -Z along the fingers, +Y toward the thumb side. */
export function gripPose(spec: GripSpec): Pose {
  const z = new Vector3(...spec.fingers).normalize().negate();
  const y = new Vector3(...spec.thumb);
  y.addScaledVector(z, -y.dot(z));
  if (y.lengthSq() < 1e-10) throw new Error('Grip thumb direction is parallel to the fingers');
  y.normalize();
  const x = new Vector3().crossVectors(y, z);
  return {
    position: new Vector3(...spec.position),
    quaternion: new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z)),
  };
}

/**
 * Where the holographic sight sits on the M4A1's flat-top rail (the rail runs
 * from z -0.173 to 0.009). `axis` is the height of the window's centre line:
 * 42 mm above the rail. The fixed front sight then shows in the lower part of
 * the window: the tops of its ears 7 mm under the axis and the tip of the post
 * 16 mm under it, clear of the dot.
 */
export const M4A1_OPTIC = {
  /** Top of the rail. */
  railTop: 0.1233,
  axis: 0.1651,
  /** Rear face of the sight's hood: the plane of the window the eye looks through. */
  window: -0.09,
  /** Rear face of the sight body. */
  rear: -0.076,
} as const;

export const M4A1_LAYOUT: GunLayout = {
  asset: 'mdl-gun-m4a1',
  realLength: 0.84,
  muzzle: [0, 0.0965, -0.5508],
  ejection: [0.0165, 0.0977, -0.105],
  ejectionTiltDeg: 12,
  sightRear: [0, M4A1_OPTIC.axis, M4A1_OPTIC.window],
  sightFront: [0, M4A1_OPTIC.axis, -0.6],
  // The eye is over the rear of the receiver: the hood then spans about a sixth of the screen.
  eyeRelief: 0.15,
  parts: { bolt: 'bolt', magazine: 'magazine', trigger: 'trigger', chargingHandle: 'chargingHandle' },
  cycleTravel: 0.07,
  grips: {
    // Right palm on the right side of the raked pistol grip.
    trigger: { position: [0.012, 0.03, 0.012], fingers: [0, -0.35, -1], thumb: [0, 1, 0] },
    // Left palm cupping the quad rail from below.
    // Mid handguard, clear of the front sight base; the thumb lies forward along the left rail.
    support: { position: [0.004, 0.066, -0.272], fingers: [0.42, 0.18, -0.89], thumb: [-0.72, 0.16, -0.67] },
  },
};

export const M249_LAYOUT: GunLayout = {
  asset: 'mdl-gun-m249',
  realLength: 1.04,
  muzzle: [0, 0.104, -0.6882],
  ejection: [0.03, 0.085, -0.146],
  ejectionTiltDeg: -25,
  sightRear: [0, 0.15875, 0.0025],
  sightFront: [0, 0.159, -0.476],
  // Closer than a real 25 cm: at that distance the peep covers a dozen pixels and hides the front post.
  eyeRelief: 0.14,
  parts: { bolt: 'bolt', magazine: 'magazine', trigger: 'trigger', chargingHandle: 'chargingHandle', cover: 'cover' },
  cycleTravel: 0.06,
  grips: {
    trigger: { position: [0.016, 0.02, 0.012], fingers: [0, -0.35, -1], thumb: [0, 1, 0] },
    // Left palm under the handguard, ahead of the belt box.
    support: { position: [-0.008, 0.018, -0.3], fingers: [0.42, 0.18, -0.89], thumb: [-0.8, 0.3, -0.5] },
  },
};
