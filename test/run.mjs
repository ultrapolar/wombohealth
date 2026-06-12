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
import { sanitize as wyzeSanitize } from '../src/sources/wyze.js';
import { sanitize as habitsSanitize } from '../src/sources/habits.js';
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

// ===== Ultrahuman: metric_data shape, CGM family, and extras passthrough =====
const ring2 = parseRing({
  data: {
    metric_data: [
      { type: 'steps', object: { total: 5000 } },
      { type: 'average_glucose', object: { value: 102 } },
      { type: 'metabolic_score', object: { value: 78 } },
      { type: 'glucose_variability', object: { value: 12 } },
      { type: 'hba1c', object: { value: 5.2 } },
      { type: 'time_in_target', object: { value: 91 } },
      { type: 'vitamin_d', object: { value: 4500 } },          // hypothetical future plug metric
      { type: 'Caffeine Window', object: { score: 65 } },      // name needs slugging
      { type: '<script>', object: { value: 1 } },              // markup stripped -> "script"
      { type: '5am_club', object: { value: 1 } },              // must start with a letter -> dropped
      { type: 'afib', object: { complex: { nested: true } } }, // no simple number -> dropped
      { type: 'hr', object: { last_reading: 70 } },            // known type, never an extra
    ],
  },
});
assert.equal(ring2.steps, 5000, 'metric_data shape parsed');
assert.equal(ring2.glucoseAvg, 102, 'average_glucose value');
assert.equal(ring2.metabolicScore, 78, 'metabolic score');
assert.equal(ring2.glucoseVariability, 12, 'glucose variability');
assert.equal(ring2.hba1c, 5.2, 'hba1c');
assert.equal(ring2.timeInTarget, 91, 'time in target');
assert.equal(ring2.extra.vitamin_d, 4500, 'unknown numeric type captured as extra');
assert.equal(ring2.extra.caffeine_window, 65, 'extra type name slugged');
assert.equal(ring2.extra.script, 1, 'markup stripped from extra type name');
assert.equal('5am_club' in ring2.extra, false, 'extra name must start with a letter');
assert.equal('afib' in ring2.extra, false, 'non-numeric extra dropped');
assert.equal('hr' in ring2.extra, false, 'known types excluded from extras');
const glucoseGraphRing = parseRing({
  data: { metric_data: [{ type: 'glucose', object: { values: [{ value: 100, timestamp: 1 }, { value: 0, timestamp: 2 }, { value: 110, timestamp: 3 }] } }] },
});
assert.equal(glucoseGraphRing.glucoseAvg, 105, 'glucose graph averaged ignoring zero dropouts');
assert.deepEqual(parseRing(load('daily_metrics.sample.json')).extra, {}, 'fixture has no extras');

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

// --- Wyze body composition ---
const wclean = wyzeSanitize({ measured_at: 1748390400, body: { weight_kg: 78.2, bmr_kcal: '1680', evil: '<x>', body_fat_pct: 18.4 } });
assert.equal(wclean.body.weight_kg, 78.2, 'wyze weight kept');
assert.equal(wclean.body.bmr_kcal, 1680, 'wyze numeric string coerced');
assert.equal('evil' in wclean.body, false, 'wyze non-allowlisted field dropped');
assert.equal(wclean.measured_at, 1748390400, 'wyze measured_at kept');

const uWyze = buildUnified({
  date: '2026-05-30', ring, home,
  wyze: { connected: true, carried_forward: true, measured_date: '2026-05-28', body: { weight_kg: 78.2, body_fat_pct: 18.4 } },
});
assert.equal(uWyze.wyze.body.weight_kg, 78.2, 'unified carries wyze body');

const dispBody = buildDisplay({
  ring, home, chart, hrvTrend: '▲', lastUpdated: '07:30', homeEnabled: true,
  sources: { wyze: { connected: true, carried_forward: true, measured_date: '2026-05-28',
    body: { weight_kg: 78.2, body_fat_pct: 18.4, muscle_mass_kg: 60.1, visceral_fat: 7, bmr_kcal: 1680 } } },
});
assert.equal(dispBody.body.weight, '78.2kg', 'display body weight');
assert.equal(dispBody.body.body_fat, '18.4%', 'display body fat');
assert.equal(dispBody.body.stale, true, 'display body carried-forward flag');

// --- Healthy habits ingest ---
const hclean = habitsSanitize({
  done: ['Supplements', 'Intentional Walk'],
  habits: { meditation: true, walk_min: '25', alcohol: false, '<script>': 1, '': 1, '5am': 1, big: 9e9 },
});
assert.equal(hclean.supplements, 1, 'habit done list -> 1');
assert.equal(hclean.intentional_walk, 1, 'habit name slugged (spaces, case)');
assert.equal(hclean.meditation, 1, 'habit boolean true -> 1');
assert.equal(hclean.walk_min, 25, 'habit numeric string coerced');
assert.equal(hclean.alcohol, 0, 'habit explicit false kept as 0');
assert.equal(Object.keys(hclean).some((k) => k.includes('<')), false, 'habit markup name dropped');
assert.equal('5am' in hclean, false, 'habit name must start with a letter');
assert.equal(hclean.big, 100000, 'habit value clamped');
assert.equal('' in hclean, false, 'empty habit name dropped');

const uHabits = buildUnified({ date: '2026-05-30', ring, home, habits: { supplements: 1, meditation: 0 } });
assert.equal(uHabits.habits.supplements, 1, 'unified carries habits');
assert.equal(uHabits.habits.meditation, 0, 'unified keeps explicit habit 0');
assert.equal(unified.habits, null, 'habits default to null when not ingested');

// --- Ultrahuman metabolic + extras in the unified model ---
const uPlugs = buildUnified({ date: '2026-05-30', ring: ring2, home: null });
assert.equal(uPlugs.ultrahuman.metabolic.glucose_avg, 102, 'unified metabolic glucose');
assert.equal(uPlugs.ultrahuman.metabolic.metabolic_score, 78, 'unified metabolic score');
assert.equal(uPlugs.ultrahuman.extra.vitamin_d, 4500, 'unified carries extras');
assert.equal(unified.ultrahuman.metabolic, null, 'metabolic null without CGM data');
assert.equal(unified.ultrahuman.extra, null, 'extra null when none captured');

console.log('PASS: worker logic + all source normalizers OK');
console.log(`sources in unified model: ${['ultrahuman', 'withings', 'fitbit', 'polar', 'samsung'].filter((k) => k === 'ultrahuman' || unified[k]).join(', ')}`);
