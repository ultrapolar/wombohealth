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
