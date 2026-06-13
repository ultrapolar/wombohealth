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
import { buildUnified } from '../src/aggregate.js';
import { routeRamble } from '../src/rambles.js';
import { parseICS, expandEvents } from '../src/calendar.js';
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

// --- Rambles keyword routing ---
const r1 = routeRamble('To do buy oat milk');
assert.equal(r1.category, 'todo', 'todo keyword routed');
assert.equal(r1.text, 'buy oat milk', 'todo keyword stripped');
const r2 = routeRamble('Important, call mom tomorrow');
assert.equal(r2.category, 'important', 'important keyword routed');
assert.equal(r2.text, 'call mom tomorrow', 'important keyword + punctuation stripped');
const r3 = routeRamble('just walked past the bakery again');
assert.equal(r3.category, 'ramble', 'no keyword -> ramble');
assert.equal(r3.text, 'just walked past the bakery again', 'ramble text untouched');
const r4 = routeRamble('idea: pebble app that waters plants');
assert.equal(r4.category, 'idea', 'idea keyword routed');
assert.equal(r4.text, 'pebble app that waters plants', 'idea colon stripped');
const r5 = routeRamble('to do get eggs', 'important');
assert.equal(r5.category, 'important', 'explicit category override wins');
assert.equal(r5.text, 'get eggs', 'keyword still stripped on override');
assert.equal(routeRamble('todo'), null, 'keyword-only note rejected');
assert.equal(routeRamble('   '), null, 'blank note rejected');
assert.equal(routeRamble('todoist sounds nice').category, 'ramble', 'keyword must be a whole word');

// --- Proton/ICS calendar ---
const ics = readFileSync(join(here, 'fixtures', 'proton.sample.ics'), 'utf8');
const rawEvents = parseICS(ics);
assert.equal(rawEvents.length, 4, 'ics vevent count');
// Window: Fri 2026-06-12 00:00 UTC .. +7 days
const winStart = Date.UTC(2026, 5, 12);
const winEnd = winStart + 7 * 86400000;
const agenda = expandEvents(rawEvents, winStart, winEnd, 'Europe/Zurich');
const titles = agenda.map((e) => e.title);
assert.ok(titles.includes('Dentist, Dr. Molar'), 'escaped comma unescaped');
assert.ok(!titles.includes('Ancient history'), 'past event excluded');
const folded = agenda.find((e) => e.all_day);
assert.ok(folded && folded.title.endsWith('folds across lines'), 'folded line + all-day');
const standups = agenda.filter((e) => e.title === 'Standup');
// Week of Jun 12-18 has Fri 12, Mon 15 (EXDATE'd), Wed 17 -> 2 instances
assert.equal(standups.length, 2, 'weekly BYDAY expansion with EXDATE');
const days = standups.map((e) => new Date(e.start * 1000).getUTCDay()).sort();
assert.deepEqual(days, [3, 5], 'standup lands Wed+Fri (Mon excluded)');
// TZID Europe/Zurich 09:15 in June = 07:15 UTC (CEST)
assert.equal(new Date(standups[0].start * 1000).getUTCHours(), 7, 'TZID converted with DST');
assert.ok(agenda.every((e, i) => i === 0 || agenda[i - 1].start <= e.start), 'agenda sorted');

// Recurrence must be expanded in wall-clock space, not epoch space:
// (a) a weekly 09:15 Zurich meeting created in winter (CET, UTC+1) must still
//     be 09:15 local in summer (CEST, UTC+2) -> 07:15 UTC, not 08:15.
const winterSeries = parseICS([
  'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:winter@x',
  'DTSTART;TZID=Europe/Zurich:20260105T091500',
  'DTEND;TZID=Europe/Zurich:20260105T100000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO', 'SUMMARY:Winter standup',
  'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
const summerOcc = expandEvents(winterSeries, Date.UTC(2026, 5, 12), Date.UTC(2026, 5, 19), 'Europe/Zurich');
assert.equal(summerOcc.length, 1, 'one Monday in window');
assert.equal(new Date(summerOcc[0].start * 1000).getUTCHours(), 7, 'wall-clock 09:15 across DST change');
// (b) BYDAY matches the LOCAL weekday: Mon 00:30 Zurich = Sun 22:30/23:30 UTC.
const midnightSeries = parseICS([
  'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:mid@x',
  'DTSTART;TZID=Europe/Zurich:20260105T003000',
  'DTEND;TZID=Europe/Zurich:20260105T013000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO', 'SUMMARY:Midnight Monday',
  'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
const midOcc = expandEvents(midnightSeries, Date.UTC(2026, 5, 12), Date.UTC(2026, 5, 19), 'Europe/Zurich');
assert.equal(midOcc.length, 1, 'local-Monday event near midnight not dropped');
assert.equal(new Date(midOcc[0].start * 1000).getUTCDay(), 0, 'occurrence is Sunday in UTC (Monday in Zurich)');

console.log('PASS: worker logic + all source normalizers OK');
console.log(`sources in unified model: ${['ultrahuman', 'withings', 'fitbit', 'polar', 'samsung'].filter((k) => k === 'ultrahuman' || unified[k]).join(', ')}`);
