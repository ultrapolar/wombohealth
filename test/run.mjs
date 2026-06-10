// Offline logic test for the worker's pure functions (no network, no wrangler).
// Run: node test/run.mjs
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseRing, parseHome } from '../src/sources/ultrahuman.js';
import { normalizeSleep as withingsNormalize } from '../src/sources/withings.js';
import { normalize as fitbitNormalize } from '../src/sources/fitbit.js';
import { normalize as polarNormalize } from '../src/sources/polar.js';
import { normalize as samsungNormalize } from '../src/sources/samsung.js';
import { buildUnified } from '../src/aggregate.js';
import { buildDisplay } from '../src/display.js';
import { weeklyChart, trend, formatDuration, isValidDate, timingSafeEqual } from '../src/lib/util.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, 'fixtures', f), 'utf8'));

// ===== Ultrahuman =====
const ring = parseRing(load('daily_metrics.sample.json'));
const home = parseHome(load('home_metrics.sample.json'));
assert.equal(ring.sleepScore, 82, 'ring sleep score');
assert.equal(ring.steps, 8423, 'ring steps');
assert.equal(ring.hrv, 44, 'ring hrv');
assert.equal(Math.round(ring.spo2), 97, 'ring spo2');
assert.equal(ring.sleepSec, 27000, 'ring sleepSec');
assert.equal(home.co2, 650, 'home co2');
assert.equal(home.pm25, 8, 'home pm25');
assert.equal(home.tempC, 22.5, 'home temp');

// ===== Withings =====
const w = withingsNormalize({
  series: [{ date: '2026-05-30', data: {
    deepsleepduration: 3600, remsleepduration: 5400, lightsleepduration: 14400,
    wakeupduration: 1200, hr_average: 58, hr_min: 52, rr_average: 15, snoring: 360, sleep_score: 72,
  } }],
});
assert.equal(w.deep_min, 60, 'withings deep_min');
assert.equal(w.rem_min, 90, 'withings rem_min');
assert.equal(w.light_min, 240, 'withings light_min');
assert.equal(w.duration_min, 390, 'withings duration_min');
assert.equal(w.score, 72, 'withings score');
assert.equal(w.snoring_min, 6, 'withings snoring_min');

// ===== Fitbit =====
const f = fitbitNormalize({
  sleep: { sleep: [{ isMainSleep: true, minutesAsleep: 430, efficiency: 95 }],
    summary: { totalMinutesAsleep: 430, stages: { deep: 70, light: 270, rem: 90, wake: 35 } } },
  activity: { summary: { steps: 9120, veryActiveMinutes: 25, fairlyActiveMinutes: 16,
    caloriesOut: 2450, distances: [{ activity: 'total', distance: 7.3 }] } },
  heart: { 'activities-heart': [{ value: { restingHeartRate: 56 } }] },
  hrv: { hrv: [{ value: { dailyRmssd: 38 } }] },
  spo2: { value: { avg: 96 } },
  br: { br: [{ value: { breathingRate: 15.2 } }] },
});
assert.equal(f.sleep.duration_min, 430, 'fitbit sleep duration');
assert.equal(f.sleep.deep_min, 70, 'fitbit deep');
assert.equal(f.activity.steps, 9120, 'fitbit steps');
assert.equal(f.activity.active_min, 41, 'fitbit active_min');
assert.equal(f.activity.distance_m, 7300, 'fitbit distance_m');
assert.equal(f.vitals.rhr, 56, 'fitbit rhr');
assert.equal(f.vitals.spo2, 96, 'fitbit spo2');
assert.equal(f.vitals.hrv, 38, 'fitbit hrv');

// ===== Polar =====
const p = polarNormalize({
  sleep: { deep_sleep: 4500, rem_sleep: 5280, light_sleep: 15420, total_interruption_duration: 1080, sleep_score: 80 },
  recharge: { heart_rate_avg: 53, beat_to_beat_avg: 42, nightly_recharge_status: 4 },
});
assert.equal(p.sleep.deep_min, 75, 'polar deep');
assert.equal(p.sleep.rem_min, 88, 'polar rem');
assert.equal(p.sleep.duration_min, 420, 'polar duration');
assert.equal(p.sleep.score, 80, 'polar score');
assert.equal(p.vitals.rhr, 53, 'polar rhr');
assert.equal(p.vitals.hrv, 42, 'polar hrv');
assert.equal(p.extra.nightly_recharge_status, 4, 'polar recharge status');

// ===== Samsung (ingest passthrough) =====
const s = samsungNormalize({ sleep: { duration_min: 400, score: 77 }, activity: { steps: 8000 }, vitals: { rhr: 58 } });
assert.equal(s.connected, true, 'samsung connected');
assert.equal(s.sleep.duration_min, 400, 'samsung sleep');
assert.equal(samsungNormalize(null), null, 'samsung null passthrough');

// ===== Unified model (the /json contract) =====
const unified = buildUnified({
  date: '2026-05-30', ring, home, withings: { connected: true, sleep: w, vitals: { rhr: 52 } },
  fitbit: f, polar: p, samsung: s, trends: { hrv: 'up' },
});
assert.equal(unified.ultrahuman.sleep.duration_min, 450, 'unified UH duration_min');
assert.equal(unified.ultrahuman.home.temp_c, 22.5, 'unified home temp_c (snake)');
assert.equal(unified.withings.sleep.deep_min, 60, 'unified withings deep');
assert.equal(unified.fitbit.activity.steps, 9120, 'unified fitbit steps');
assert.equal(unified.polar.sleep.duration_min, 420, 'unified polar duration');
assert.equal(unified.samsung.connected, true, 'unified samsung attached');

// ===== Helpers + display =====
assert.equal(formatDuration(27000), '7h 30m', 'formatDuration');

// --- security helpers ---
assert.equal(isValidDate('2026-05-30'), true, 'valid date accepted');
assert.equal(isValidDate('2026-13-40'), false, 'impossible date rejected');
assert.equal(isValidDate('2026-5-3'), false, 'loose format rejected');
assert.equal(isValidDate('2026-05-30 OR 1=1'), false, 'injection rejected');
assert.equal(timingSafeEqual('secret', 'secret'), true, 'equal keys match');
assert.equal(timingSafeEqual('secret', 'secреt'), false, 'different keys differ');
assert.equal(timingSafeEqual('abc', 'abcd'), false, 'length mismatch rejected');
const chart = weeklyChart({ '2026-05-30': 8423 }, '2026-05-30', 10000);
assert.equal(chart.length, 7, 'chart length');
const display = buildDisplay({ ring, home, chart, hrvTrend: trend(44, 40).icon, lastUpdated: '07:30', homeEnabled: true });
assert.equal(display.sleep_duration, '7h 30m', 'display sleep_duration');
assert.equal(display.home_co2, '650', 'display home_co2');
assert.equal(display.hrv_icon, '▲', 'display hrv trend up');
assert.equal(display.secondary.length, 0, 'display secondary empty without sources');

const display2 = buildDisplay({
  ring, home, chart, hrvTrend: '▲', lastUpdated: '07:30', homeEnabled: true,
  sources: {
    withings: { connected: true, sleep: { duration_min: 415, score: 72 }, vitals: { rhr: 52 } },
    fitbit: { connected: true, activity: { steps: 9120 }, vitals: { rhr: 56, hrv: 38 } },
  },
});
assert.equal(display2.secondary.length, 2, 'display secondary count');
assert.equal(display2.secondary[0].name, 'Withings', 'secondary[0] name');
assert.equal(display2.secondary[0].sleep, '6h 55m', 'secondary withings sleep fmt');
assert.equal(display2.secondary[1].steps, 9120, 'secondary fitbit steps');

console.log('PASS: worker logic + all source normalizers OK');
console.log(`sources in unified model: ${['ultrahuman', 'withings', 'fitbit', 'polar', 'samsung'].filter((k) => k === 'ultrahuman' || unified[k]).join(', ')}`);
