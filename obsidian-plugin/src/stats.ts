// Pure blending math for the holistic graph. No Obsidian/DOM deps, so it can be
// bundled to ESM and unit-tested under Node (see test/stats.test.mjs).

export interface Weighted {
  value: number;
  weight: number;
}

export function weightedMean(items: Weighted[]): number | null {
  const valid = items.filter((i) => Number.isFinite(i.value) && i.weight > 0);
  if (!valid.length) return null;
  const wsum = valid.reduce((a, b) => a + b.weight, 0);
  if (wsum <= 0) return null;
  return valid.reduce((a, b) => a + b.value * b.weight, 0) / wsum;
}

// Weighted population standard deviation around `mean`. Needs >= 2 readings.
export function weightedStd(items: Weighted[], mean: number | null): number | null {
  const valid = items.filter((i) => Number.isFinite(i.value) && i.weight > 0);
  if (valid.length < 2 || mean === null) return null;
  const wsum = valid.reduce((a, b) => a + b.weight, 0);
  if (wsum <= 0) return null;
  const variance = valid.reduce((a, b) => a + b.weight * (b.value - mean) ** 2, 0) / wsum;
  return Math.sqrt(variance);
}

export function minMax(values: number[]): { min: number; max: number } | null {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  return { min: Math.min(...v), max: Math.max(...v) };
}

// Tier rank (0 = top priority) → weight, given how many devices are included.
export function tierWeight(rank: number, count: number): number {
  return Math.max(1, count - rank);
}
