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

// Resolve one device's weight for one metric. A per-metric override (user-entered,
// e.g. "steps: Fitbit 40 / Polar 40 / UH 10") always wins over the global mode;
// override 0 keeps the device visible (whiskers/faint line) but out of the blend.
export function resolveWeight(opts: {
  override?: number;
  mode: "tier" | "equal" | "custom";
  rank: number;
  count: number;
  customWeight?: number;
}): number {
  if (typeof opts.override === "number" && Number.isFinite(opts.override) && opts.override >= 0) {
    return opts.override;
  }
  if (opts.mode === "equal") return 1;
  if (opts.mode === "custom") return opts.customWeight ?? 1;
  return tierWeight(opts.rank, opts.count);
}

// ---------------------------------------------------------------------------
// Habit ↔ metric correlation math
// ---------------------------------------------------------------------------

export interface Pair {
  x: number; // habit value for the day (0/1 for done/not, or a quantity like minutes)
  y: number; // metric value for the (possibly lagged) day
}

// Pearson r. With a binary x this is the point-biserial correlation, so the same
// function covers checkbox habits and quantity habits. Needs >= 3 pairs and
// variance in both series (a habit done every day can't be correlated with anything).
export function pearson(pairs: Pair[]): number | null {
  const n = pairs.length;
  if (n < 3) return null;
  const mx = pairs.reduce((a, p) => a + p.x, 0) / n;
  const my = pairs.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const p of pairs) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
  }
  if (sxx <= 0 || syy <= 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

export interface HabitEffect {
  r: number | null;
  n: number; // total paired days
  doneN: number; // days the habit was done (x > 0)
  restN: number; // days it wasn't
  doneMean: number | null; // metric mean on habit days
  restMean: number | null; // metric mean on the other days
  diffPct: number | null; // (doneMean - restMean) / |restMean| * 100
}

// Compare a metric on habit vs non-habit days, plus the correlation. `minPerGroup`
// gates r and diffPct: with fewer than that many days on either side the split is
// too lopsided to mean anything, so they come back null (the means still report).
export function habitEffect(pairs: Pair[], minPerGroup = 3): HabitEffect {
  const done = pairs.filter((p) => p.x > 0);
  const rest = pairs.filter((p) => p.x <= 0);
  const mean = (ps: Pair[]) => (ps.length ? ps.reduce((a, p) => a + p.y, 0) / ps.length : null);
  const doneMean = mean(done);
  const restMean = mean(rest);
  const enough = done.length >= minPerGroup && rest.length >= minPerGroup;
  const r = enough ? pearson(pairs) : null;
  let diffPct: number | null = null;
  if (enough && doneMean !== null && restMean !== null && restMean !== 0) {
    diffPct = ((doneMean - restMean) / Math.abs(restMean)) * 100;
  }
  return { r, n: pairs.length, doneN: done.length, restN: rest.length, doneMean, restMean, diffPct };
}

// "2026-06-11" + 1 -> "2026-06-12". UTC math, so no DST surprises.
export function shiftDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return `${t.getUTCFullYear()}-${mm}-${dd}`;
}

// Pair each habit day with the metric `lagDays` later. Lag matters because the
// exporter files a night's sleep under the wake date: a walk on the 10th shows up
// in the sleep/HRV written to the 11th, but in the 10th's own step count.
export function alignPairs(
  habitDays: { date: string; values: Record<string, number> }[],
  metricByDate: Map<string, number>,
  habit: string,
  lagDays: number,
): Pair[] {
  const pairs: Pair[] = [];
  for (const day of habitDays) {
    const y = metricByDate.get(lagDays === 0 ? day.date : shiftDate(day.date, lagDays));
    if (y === undefined || !Number.isFinite(y)) continue;
    pairs.push({ x: day.values[habit] ?? 0, y });
  }
  return pairs;
}
