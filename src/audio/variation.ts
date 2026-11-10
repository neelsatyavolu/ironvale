/**
 * Picks which take of a sound to play. Takes rotate in a shuffled order and
 * the same take never plays twice in a row, so automatic fire and footsteps do
 * not sound like one sample on repeat.
 */
export class VariationPicker {
  private readonly last = new Map<string, number>();

  constructor(private readonly random: () => number = Math.random) {}

  /** Index in [0, count) for the next play of `group`. */
  next(group: string, count: number): number {
    if (count <= 1) return 0;
    const previous = this.last.get(group) ?? -1;
    // Choose among the other takes, so the result can never equal the previous one.
    let index = Math.floor(this.random() * (previous < 0 ? count : count - 1));
    if (previous >= 0 && index >= previous) index++;
    index = Math.min(count - 1, index);
    this.last.set(group, index);
    return index;
  }
}

/** A multiplier of 1 +/- `amount`, for pitch and level variation. */
export function jitter(random: () => number, amount: number): number {
  return 1 + (random() * 2 - 1) * amount;
}
