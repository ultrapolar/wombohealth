// Run: npm test  (bundles src/stats.ts -> test/stats.bundle.mjs first)
import assert from "node:assert";
import { weightedMean, weightedStd, minMax, tierWeight, resolveWeight } from "./stats.bundle.mjs";

const items = [
  { value: 80, weight: 3 },
  { value: 72, weight: 2 },
  { value: 76, weight: 1 },
];
const m = weightedMean(items);
assert.ok(m !== null && Math.abs(m - 76.6667) < 0.001, `weightedMean got ${m}`);

const sd = weightedStd(items, m);
assert.ok(sd !== null && sd > 0, "weightedStd should be > 0");

assert.deepEqual(minMax([80, 72, 76]), { min: 72, max: 80 }, "minMax");
assert.equal(minMax([]), null, "minMax empty -> null");

assert.equal(weightedMean([]), null, "empty mean -> null");
assert.equal(weightedMean([{ value: 5, weight: 0 }]), null, "zero weight -> null");
assert.equal(weightedStd([{ value: 5, weight: 1 }], 5), null, "sd needs >= 2 readings");

assert.equal(tierWeight(0, 3), 3, "top tier weight");
assert.equal(tierWeight(1, 3), 2, "mid tier weight");
assert.equal(tierWeight(2, 3), 1, "low tier weight");

// --- per-metric weight resolution ---
assert.equal(resolveWeight({ override: 40, mode: "tier", rank: 2, count: 3 }), 40, "override beats tier");
assert.equal(resolveWeight({ override: 0, mode: "equal", rank: 0, count: 3 }), 0, "override 0 excludes from blend");
assert.equal(resolveWeight({ mode: "equal", rank: 2, count: 3 }), 1, "equal mode fallback");
assert.equal(resolveWeight({ mode: "custom", rank: 0, count: 3, customWeight: 2.5 }), 2.5, "custom slider fallback");
assert.equal(resolveWeight({ mode: "tier", rank: 1, count: 3 }), 2, "tier fallback");
assert.equal(resolveWeight({ override: -5, mode: "equal", rank: 0, count: 3 }), 1, "negative override ignored");

// User scenario — steps: Fitbit 40 / Polar 40 / UH 10. UH reads way high (wrong 90% of
// the time); blend should sit near the Fitbit/Polar cluster, whiskers keep the outlier.
const steps = [
  { value: 9120, weight: 40 },   // fitbit
  { value: 9050, weight: 40 },   // polar
  { value: 14000, weight: 10 },  // ultrahuman (bad)
];
const blend = weightedMean(steps);
assert.ok(blend !== null && Math.abs(blend - 9631.11) < 0.5, `blend ~9631, got ${blend}`);
assert.deepEqual(minMax(steps.map((s) => s.value)), { min: 9050, max: 14000 }, "whiskers keep the UH outlier");
const zeroed = weightedMean([{ value: 9120, weight: 40 }, { value: 9050, weight: 40 }, { value: 14000, weight: 0 }]);
assert.ok(zeroed !== null && Math.abs(zeroed - 9085) < 0.5, `weight 0 fully drops UH from blend, got ${zeroed}`);

console.log("PASS: stats math OK");

// --- habit correlation math ---
import { pearson, habitEffect, shiftDate, alignPairs } from "./stats.bundle.mjs";

assert.equal(shiftDate("2026-06-11", 1), "2026-06-12", "shiftDate +1");
assert.equal(shiftDate("2026-12-31", 1), "2027-01-01", "shiftDate year rollover");
assert.equal(shiftDate("2024-02-28", 1), "2024-02-29", "shiftDate leap day");
assert.equal(shiftDate("2026-06-11", 0), "2026-06-11", "shiftDate zero");

// Perfectly correlated quantity habit (more meditation minutes -> more HRV).
const pos = [
  { x: 0, y: 40 }, { x: 10, y: 45 }, { x: 20, y: 50 }, { x: 30, y: 55 },
];
const rp = pearson(pos);
assert.ok(rp !== null && Math.abs(rp - 1) < 1e-9, `perfect positive r, got ${rp}`);

const neg = pos.map((p) => ({ x: p.x, y: -p.y }));
const rn = pearson(neg);
assert.ok(rn !== null && Math.abs(rn + 1) < 1e-9, `perfect negative r, got ${rn}`);

assert.equal(pearson([{ x: 1, y: 2 }, { x: 2, y: 3 }]), null, "pearson needs >= 3 pairs");
assert.equal(pearson([{ x: 1, y: 2 }, { x: 1, y: 3 }, { x: 1, y: 4 }]), null, "no x variance -> null");

// Binary habit: HRV averages 50 on habit days, 42 otherwise.
const habitDays = [
  { x: 1, y: 50 }, { x: 1, y: 52 }, { x: 1, y: 48 },
  { x: 0, y: 42 }, { x: 0, y: 40 }, { x: 0, y: 44 },
];
const eff = habitEffect(habitDays);
assert.equal(eff.n, 6, "habitEffect n");
assert.equal(eff.doneN, 3, "habitEffect doneN");
assert.equal(eff.restN, 3, "habitEffect restN");
assert.ok(Math.abs(eff.doneMean - 50) < 1e-9, `doneMean 50, got ${eff.doneMean}`);
assert.ok(Math.abs(eff.restMean - 42) < 1e-9, `restMean 42, got ${eff.restMean}`);
assert.ok(eff.r !== null && eff.r > 0.8, `binary habit r should be strongly positive, got ${eff.r}`);
assert.ok(Math.abs(eff.diffPct - (8 / 42) * 100) < 0.01, `diffPct ~19%, got ${eff.diffPct}`);

// Lopsided split: habit done all but once -> means still report, r/diff gated off.
const lop = habitEffect([
  { x: 1, y: 50 }, { x: 1, y: 51 }, { x: 1, y: 49 }, { x: 1, y: 52 }, { x: 0, y: 41 },
]);
assert.equal(lop.r, null, "lopsided split -> r gated");
assert.equal(lop.diffPct, null, "lopsided split -> diffPct gated");
assert.ok(lop.doneMean !== null && lop.restMean !== null, "means still report");

// alignPairs: lag 1 pairs the habit with the NEXT day's metric; missing days drop out.
const hd = [
  { date: "2026-06-01", values: { walk: 1 } },
  { date: "2026-06-02", values: {} },          // observed day, habit not done -> x=0
  { date: "2026-06-03", values: { walk: 1 } }, // next day missing from metrics -> dropped
];
const metric = new Map([
  ["2026-06-01", 40], ["2026-06-02", 48], ["2026-06-03", 41],
]);
assert.deepEqual(alignPairs(hd, metric, "walk", 1), [
  { x: 1, y: 48 }, { x: 0, y: 41 },
], "lag-1 alignment");
assert.deepEqual(alignPairs(hd, metric, "walk", 0), [
  { x: 1, y: 40 }, { x: 0, y: 48 }, { x: 1, y: 41 },
], "same-day alignment");

console.log("PASS: habit correlation math OK");

// --- dynamic metric discovery (Worker extras passthrough) ---
const { discoverMetrics, METRICS, buildMetricSeries, defaultPrefs } = await import("./data.bundle.mjs");

const dynRows = [
  { date: "2026-06-10", values: { ultrahuman_hrv: 44, ultrahuman_vitamin_d: 4500, ultrahuman_glucose_avg: 102 } },
  { date: "2026-06-11", values: { ultrahuman_vitamin_d: 3000, fitbit_zone_minutes: 32 } },
];
const dyn = discoverMetrics(dynRows);
assert.deepEqual(dyn.map((m) => m.key), ["vitamin_d", "zone_minutes"], "extras discovered, canonical keys excluded");
assert.equal(dyn[0].label, "Vitamin D", "extra label title-cased");
assert.equal(dyn[0].group, "Other", "extras grouped under Other");

// Known dynamic metrics get proper labels and correlation directions.
const known = discoverMetrics([
  { date: "2026-06-10", values: { polar_ans_charge: 3.7, samsung_ages_index: 45, samsung_antioxidant_index: 64 } },
]);
const byKey = Object.fromEntries(known.map((m) => [m.key, m]));
assert.equal(byKey.ans_charge.label, "ANS charge", "ANS charge labeled");
assert.equal(byKey.ans_charge.better, "high", "ANS charge direction");
assert.equal(byKey.ages_index.better, "low", "AGEs index lower-is-better");
assert.equal(byKey.antioxidant_index.label, "Antioxidant index", "antioxidant labeled");
assert.ok(METRICS.some((m) => m.key === "glucose_avg" && m.group === "Metabolic"), "metabolic metric registered");
const dynSeries = buildMetricSeries(dyn[0], dynRows, defaultPrefs());
assert.deepEqual(dynSeries.perDevice[0].points, [4500, 3000], "dynamic metric charts from rows");
assert.equal(discoverMetrics([]).length, 0, "no rows -> no dynamic metrics");

console.log("PASS: dynamic metric discovery OK");
