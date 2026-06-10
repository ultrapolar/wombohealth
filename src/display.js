// Map normalized data into the flat payload TRMNL polls (GET /). Keys mirror the
// upstream payload (so existing Liquid keeps working) plus home_* air-quality keys
// and a `secondary` array of any connected non-Ultrahuman sources.
import { formatDuration } from './lib/util.js';

const hm = (min) =>
  min ? `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m` : '';

// One compact row per connected secondary source, or null if it has nothing.
function srcEntry(name, src) {
  if (!src) return null;
  const sl = src.sleep || {};
  const ac = src.activity || {};
  const vi = src.vitals || {};
  const e = {
    name,
    sleep: hm(sl.duration_min),
    score: sl.score ?? '',
    steps: ac.steps ?? '',
    rhr: vi.rhr ?? '',
    hrv: vi.hrv ?? '',
    spo2: vi.spo2 != null ? `${vi.spo2}%` : '',
  };
  if (!e.sleep && e.steps === '' && e.rhr === '' && e.hrv === '' && e.spo2 === '') return null;
  return e;
}

export function buildDisplay({ ring, home, chart, hrvTrend, lastUpdated, homeEnabled, stale, sources = {} }) {
  const p = {
    meta: { last_updated: lastUpdated, stale: !!stale },

    // SLEEP
    sleep_duration: formatDuration(ring.sleepSec),
    sleep_score: ring.sleepScore ?? '--',
    sleep_cycles: ring.cycles ?? '--',
    restorative_duration: formatDuration((ring.remSec || 0) + (ring.deepSec || 0)),
    rem_duration: formatDuration(ring.remSec),
    deep_duration: formatDuration(ring.deepSec),
    light_duration: formatDuration(ring.lightSec),

    // RECOVERY / BODY
    recovery_score: ring.recovery ?? '--',
    hrv: ring.hrv || '--',
    hrv_icon: hrvTrend || '−',
    rhr: ring.rhr || '--',
    avg_temp: ring.tempC ? `${Number(ring.tempC).toFixed(1)}°C` : '--',
    spo2: ring.spo2 ? `${Math.round(ring.spo2)}%` : '--',

    // ACTIVITY
    movement_idx: ring.movementIndex ?? '--',
    steps: ring.steps || 0,

    // WEEKLY STEP CHART
    zone_1: chart[0], zone_2: chart[1], zone_3: chart[2], zone_4: chart[3],
    zone_5: chart[4], zone_6: chart[5], zone_7: chart[6],

    // FOOTER
    vo2_max: ring.vo2Max ?? '--',
    alertness_score: ring.alertness ?? '--',
    active_min: `${ring.activeMin || 0}m`,
    time_in_bed: formatDuration(ring.timeInBedSec),

    home_enabled: !!homeEnabled,
  };

  if (homeEnabled && home) {
    p.home_aqi = home.aqi ?? '--';
    p.home_co2 = home.co2 != null ? `${home.co2}` : '--';
    p.home_pm25 = home.pm25 ?? '--';
    p.home_pm10 = home.pm10 ?? '--';
    p.home_voc = home.voc ?? '--';
    p.home_temp = home.tempC != null ? `${Number(home.tempC).toFixed(1)}°C` : '--';
    p.home_humidity = home.humidity != null ? `${home.humidity}%` : '--';
    p.home_noise = home.noise != null ? `${home.noise}dB` : '--';
  }

  // Connected non-Ultrahuman sources, for the TRMNL template to iterate over.
  p.secondary = [
    srcEntry('Withings', sources.withings),
    srcEntry('Fitbit', sources.fitbit),
    srcEntry('Polar', sources.polar),
    srcEntry('Samsung', sources.samsung),
  ].filter(Boolean);

  // Body composition (Wyze) — a dedicated tile, not a sleep/steps row.
  const wy = sources.wyze;
  if (wy && wy.body) {
    const b = wy.body;
    p.body = {
      weight: b.weight_kg != null ? `${b.weight_kg}kg` : (b.weight_lb != null ? `${b.weight_lb}lb` : '--'),
      body_fat: b.body_fat_pct != null ? `${b.body_fat_pct}%` : '--',
      muscle: b.muscle_mass_kg != null ? `${b.muscle_mass_kg}kg` : '--',
      water: b.body_water_pct != null ? `${b.body_water_pct}%` : '--',
      visceral: b.visceral_fat ?? '--',
      bmr: b.bmr_kcal ?? '--',
      measured: wy.measured_date || '--',
      stale: !!wy.carried_forward,
    };
  }

  return p;
}
