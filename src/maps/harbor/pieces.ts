/** Rectangle on a wall: `u` runs along the wall, `v` up from its base. Metres. */
export interface Rect {
  readonly u0: number;
  readonly u1: number;
  readonly v0: number;
  readonly v1: number;
}

const EPSILON = 1e-6;

/**
 * Splits a `length` x `height` wall into solid rectangles that leave the given
 * openings free. Works column by column, so stacked windows in one bay cost
 * one piece per gap and plain stretches of wall stay as single pieces.
 */
export function wallPieces(length: number, height: number, openings: readonly Rect[]): Rect[] {
  const clipped = openings
    .map((o) => ({
      u0: Math.max(0, o.u0),
      u1: Math.min(length, o.u1),
      v0: Math.max(0, o.v0),
      v1: Math.min(height, o.v1),
    }))
    .filter((o) => o.u1 - o.u0 > EPSILON && o.v1 - o.v0 > EPSILON);

  const cuts = [...new Set([0, length, ...clipped.flatMap((o) => [o.u0, o.u1])])].sort((a, b) => a - b);
  const pieces: Rect[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const u0 = cuts[i]!;
    const u1 = cuts[i + 1]!;
    if (u1 - u0 < EPSILON) continue;
    const inColumn = clipped
      .filter((o) => o.u0 <= u0 + EPSILON && o.u1 >= u1 - EPSILON)
      .sort((a, b) => a.v0 - b.v0);
    let floor = 0;
    for (const opening of inColumn) {
      if (opening.v0 - floor > EPSILON) pieces.push({ u0, u1, v0: floor, v1: opening.v0 });
      floor = Math.max(floor, opening.v1);
    }
    if (height - floor > EPSILON) pieces.push({ u0, u1, v0: floor, v1: height });
  }
  return mergeColumns(pieces);
}

/** Joins neighbouring full-height style pieces that share the same vertical span. */
function mergeColumns(pieces: readonly Rect[]): Rect[] {
  const merged: Rect[] = [];
  for (const piece of pieces) {
    const index = merged.findIndex(
      (other) =>
        Math.abs(other.u1 - piece.u0) < EPSILON &&
        Math.abs(other.v0 - piece.v0) < EPSILON &&
        Math.abs(other.v1 - piece.v1) < EPSILON,
    );
    if (index >= 0) merged[index] = { ...merged[index]!, u1: piece.u1 };
    else merged.push(piece);
  }
  return merged;
}

/** Centres of evenly spaced window bays along a wall of `length`, about `spacing` apart. */
export function bayCentres(length: number, spacing: number): number[] {
  const count = Math.max(1, Math.round(length / spacing));
  const width = length / count;
  return Array.from({ length: count }, (_, i) => (i + 0.5) * width);
}
