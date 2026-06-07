// Run: npm test  (bundles src/stats.ts -> test/stats.bundle.mjs first)
import assert from "node:assert";
import { weightedMean, weightedStd, minMax, tierWeight } from "./stats.bundle.mjs";

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

console.log("PASS: stats math OK");
