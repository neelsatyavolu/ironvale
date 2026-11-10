/**
 * Tuning for the first-person arms (../arms.ts): where the shoulders sit, how
 * the palm maps to a grip anchor and how far each finger is curled. Metres and
 * degrees, in the arms rig's space: camera at the origin looking down -Z.
 */
export type Side = 'L' | 'R';
type Triple = readonly [number, number, number];

/**
 * Shoulder anchors. They are not anatomical: the visible part of each arm is
 * the hand and forearm, so the shoulders sit low and forward, out of view,
 * where they give a natural forearm angle for both the hip and aimed poses.
 * `pole` is the direction the elbow bends toward (down and out).
 */
export const SHOULDERS: Readonly<Record<Side, { home: Triple; pole: Triple }>> = {
  R: { home: [0.3, -0.32, 0.03], pole: [0.6, -0.75, 0.25] },
  L: { home: [-0.03, -0.4, -0.34], pole: [-0.8, -0.55, 0.2] },
};

export const HAND = {
  /** Palm centre: this far from the wrist toward the knuckles (0 - 1) ... */
  palmAlong: 0.62,
  /** ... shifted toward the index-finger side ... */
  palmAcross: 0.0,
  /** ... and this far out of the plane of the hand bones, onto the skin of the palm. */
  palmDepth: 0.016,
  /** Share of the hand's roll that the forearm takes; the rest stays in the wrist. */
  forearmTwistShare: 0.7,
  /** Arm reach limits: the least shoulder-to-wrist distance, and the most as a share of full length. */
  minReach: 0.12,
  maxReach: 0.985,
} as const;

export interface FingerCurls {
  /** Extra curl of each joint from the rest pose: knuckle, middle joint, end joint. */
  readonly point: Triple;
  readonly middle: Triple;
  readonly ring: Triple;
  readonly pink: Triple;
  /** Index finger swung toward the thumb side, in the plane of the palm. */
  readonly pointSpread: number;
  /** Thumb joints swinging across the palm. */
  readonly thumb: Triple;
  /** Thumb swinging away from the index finger in the plane of the palm (negative: toward it). */
  readonly thumbSpread: number;
  /** Cupping of the outer palm (ring and little finger side). */
  readonly cup: number;
}

export const FINGER_CURLS: Readonly<Record<Side, FingerCurls>> = {
  // Trigger hand: three fingers wrapped round a pistol grip, index finger laid on the trigger.
  R: {
    point: [22, 40, 18],
    pointSpread: 14,
    middle: [70, 100, 60],
    ring: [72, 100, 60],
    pink: [74, 98, 56],
    thumb: [28, 22, 18],
    thumbSpread: 0,
    cup: 6,
  },
  // Support hand: an open C that cups a fore-end from below.
  L: {
    point: [42, 62, 32],
    pointSpread: 0,
    middle: [42, 64, 32],
    ring: [44, 64, 32],
    pink: [46, 60, 30],
    thumb: [30, 20, 14],
    thumbSpread: -12,
    cup: 4,
  },
};

/** Where the off hand rests when no support grip is given: low, out of view. */
export const TUCK: { position: Triple; fingers: Triple; thumb: Triple } = {
  position: [-0.2, -0.62, -0.18],
  fingers: [0.25, -0.2, -1],
  thumb: [0.6, 0.8, 0],
};

/** Seconds the off hand takes to move between the gun and its tucked position. */
export const SUPPORT_BLEND_SECONDS = 0.22;
