/** Published Workers AI image rate: $0.011 per 1,000 neurons. */
export const USD_PER_1K_NEURONS = 0.011;

/** Convert a neuron estimate to milliunits, rounding up to avoid underquoting. */
export const neuronsToMilliunits = (neurons: number): number =>
  Math.ceil((neurons * 11) / 10);
