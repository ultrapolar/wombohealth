// Ultrahuman source adapter: Ring (daily_metrics) + Home (air quality).
// Parsing is split from fetching so the parsers can be unit-tested on fixtures.
import { getValue, getAverage, getDurationInSeconds } from '../lib/util.js';

export const RING_URL = 'https://partner.ultrahuman.com/api/v1/partner/daily_metrics';

// NOTE: The Home Metrics endpoint path is not in the public docs yet. This is a
// best-guess default; confirm the real path + field names via GET /debug/raw
// once API_TOKEN is set, then adjust here if needed.
export const HOME_URL = 'https://partner.ultrahuman.com/api/v1/partner/home_metrics';

// daily_metrics + (presumably) home_metrics return: data.metrics[<date>] = [ {type, object}, ... ]
function metricsArray(json) {
  const root = json?.data?.metrics;
  if (!root) return null;
  const dateKey = Object.keys(root)[0];
  return root[dateKey] || null;
}

export function emptyRing() {
  return {
    steps: 0, hrv: 0, rhr: 0, vo2Max: 0, recovery: 0, movementIndex: 0, activeMin: 0,
    sleepScore: null, cycles: null, alertness: null,
    sleepSec: 0, remSec: 0, deepSec: 0, lightSec: 0, timeInBedSec: 0,
    spo2: 0, tempC: 0,
  };
}

export function ringIsEmpty(r) {
  return !r || ((r.sleepSec || 0) === 0 && (r.steps || 0) === 0 && (r.hrv || 0) === 0);
}

// Parse a daily_metrics response into a normalized ring object. Pure/testable.
// Field paths mirror the verified upstream extraction.
export function parseRing(json) {
  const items = metricsArray(json);
  if (!items) return emptyRing();

  const sleep = items.find((m) => m.type === 'sleep')?.object;
  const steps = items.find((m) => m.type === 'steps')?.object;
  const spo2Graph = items.find((m) => m.type === 'spo2')?.object;
  const tempObj = items.find((m) => m.type === 'temp')?.object;
  const hrvObj = items.find((m) => m.type === 'hrv' || m.type === 'avg_sleep_hrv')?.object;
  const rhrObj = items.find((m) => m.type === 'night_rhr' || m.type === 'sleep_rhr')?.object;
  const vo2Obj = items.find((m) => m.type === 'vo2_max')?.object;
  const activeObj = items.find((m) => m.type === 'active_minutes')?.object;
  const moveObj = items.find((m) => m.type === 'movement_index')?.object;
  const recObj = items.find((m) => m.type === 'recovery_index')?.object;

  let spo2 = 0;
  if (sleep?.spo2?.value) spo2 = sleep.spo2.value;
  else spo2 = getAverage(spo2Graph, true);

  let tempC = 0;
  if (sleep?.average_body_temperature?.celsius) tempC = sleep.average_body_temperature.celsius;
  else tempC = getAverage(tempObj);

  let sleepScore = null;
  if (sleep?.sleep_score?.score) sleepScore = sleep.sleep_score.score;
  else if (sleep?.score) sleepScore = sleep.score;

  let cycles = null;
  if (sleep?.full_sleep_cycles?.cycles) cycles = sleep.full_sleep_cycles.cycles;

  let alertness = null;
  if (sleep?.morning_alertness?.index) alertness = sleep.morning_alertness.index;
  else if (sleep?.alertness_index) alertness = sleep.alertness_index;

  return {
    steps: getValue(steps, 'total'),
    hrv: Math.round(getValue(hrvObj, 'avg')) || 0,
    rhr: getValue(rhrObj, 'avg'),
    vo2Max: getValue(vo2Obj),
    recovery: getValue(recObj),
    movementIndex: getValue(moveObj),
    activeMin: getValue(activeObj, 'total') || getValue(activeObj) || 0,
    sleepScore,
    cycles,
    alertness,
    sleepSec: getDurationInSeconds(sleep, 'total_sleep'),
    remSec: getDurationInSeconds(sleep, 'rem_sleep'),
    deepSec: getDurationInSeconds(sleep, 'deep_sleep'),
    lightSec: getDurationInSeconds(sleep, 'light_sleep'),
    timeInBedSec: getDurationInSeconds(sleep, 'time_in_bed'),
    spo2,
    tempC,
  };
}

// Parse a home_metrics response into a normalized air-quality object.
// Tolerant of both the typed-array shape (like daily_metrics) and a flat object.
// Field set is PROVISIONAL until confirmed via /debug/raw.
export function parseHome(json) {
  const out = {
    aqi: null, voc: null, hcho: null, co: null, co2: null,
    pm1: null, pm25: null, pm10: null, tempC: null,
    humidity: null, noise: null, light: null, uv: null,
  };
  if (!json) return out;
  const items = metricsArray(json);

  const pick = (names, sub = 'value') => {
    for (const n of names) {
      const typed = items?.find?.((m) => m.type === n)?.object;
      if (typed !== undefined && typed !== null) {
        return typeof typed === 'object'
          ? (typed[sub] ?? typed.value ?? typed.celsius ?? typed.avg ?? null)
          : typed;
      }
      const flat = json?.data?.[n] ?? json?.[n];
      if (flat !== undefined && flat !== null) {
        return typeof flat === 'object' ? (flat[sub] ?? flat.value ?? null) : flat;
      }
    }
    return null;
  };

  out.aqi = pick(['aqi', 'air_quality_index']);
  out.voc = pick(['voc', 'tvoc']);
  out.hcho = pick(['hcho', 'formaldehyde']);
  out.co = pick(['co', 'carbon_monoxide']);
  out.co2 = pick(['co2', 'co_2', 'carbon_dioxide']);
  out.pm1 = pick(['pm1', 'pm_1']);
  out.pm25 = pick(['pm2_5', 'pm25', 'pm_2_5']);
  out.pm10 = pick(['pm10', 'pm_10']);
  out.tempC = pick(['temperature', 'temp'], 'celsius');
  out.humidity = pick(['humidity', 'relative_humidity']);
  out.noise = pick(['noise', 'sound', 'noise_level']);
  out.light = pick(['light', 'lux', 'illuminance']);
  out.uv = pick(['uv', 'uv_index']);
  return out;
}

// --- network wrappers (Workers runtime; not exercised by unit tests) ---

export async function fetchRing(dateStr, token) {
  const resp = await fetch(`${RING_URL}?date=${dateStr}`, { headers: { Authorization: token } });
  if (!resp.ok) return emptyRing();
  return parseRing(await resp.json());
}

export async function fetchHome(dateStr, token) {
  try {
    const resp = await fetch(`${HOME_URL}?date=${dateStr}`, { headers: { Authorization: token } });
    if (!resp.ok) return parseHome(null);
    return parseHome(await resp.json());
  } catch {
    return parseHome(null);
  }
}

// Raw passthrough for schema discovery via /debug/raw.
export async function fetchRaw(url, dateStr, token) {
  try {
    const resp = await fetch(`${url}?date=${dateStr}`, { headers: { Authorization: token } });
    const body = await resp.text();
    return { ok: resp.ok, status: resp.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: String(e) };
  }
}
