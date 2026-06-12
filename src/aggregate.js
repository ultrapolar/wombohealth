// Build the unified, source-agnostic health model for a single day.
// This is the contract the Obsidian exporter (and any future consumer) reads
// from GET /json. Additional sources attach under their own top-level keys.

export function buildUnified({
  date, ring, home, withings = null, fitbit = null, polar = null, samsung = null, wyze = null,
  habits = null, trends = {}, stale = false,
}) {
  return {
    date,
    generated_at: new Date().toISOString(),
    stale,
    ultrahuman: {
      sleep: {
        score: ring.sleepScore,
        duration_sec: ring.sleepSec,
        duration_min: Math.round((ring.sleepSec || 0) / 60),
        rem_sec: ring.remSec,
        deep_sec: ring.deepSec,
        light_sec: ring.lightSec,
        time_in_bed_sec: ring.timeInBedSec,
        cycles: ring.cycles,
        alertness: ring.alertness,
        hrv: ring.hrv || null,
        rhr: ring.rhr || null,
        spo2: ring.spo2 ? Math.round(ring.spo2) : null,
        temp_c: ring.tempC ? Number(Number(ring.tempC).toFixed(1)) : null,
      },
      recovery: { index: ring.recovery || null },
      activity: {
        steps: ring.steps || 0,
        active_min: ring.activeMin || 0,
        movement_index: ring.movementIndex || null,
        vo2_max: ring.vo2Max || null,
      },
      // CGM / metabolic family — null unless an M1 sensor reports for this day.
      metabolic: [ring.glucoseAvg, ring.metabolicScore, ring.glucoseVariability, ring.hba1c, ring.timeInTarget]
        .some((v) => v != null)
        ? {
            glucose_avg: ring.glucoseAvg ?? null,
            metabolic_score: ring.metabolicScore ?? null,
            glucose_variability: ring.glucoseVariability ?? null,
            hba1c: ring.hba1c ?? null,
            time_in_target: ring.timeInTarget ?? null,
          }
        : null,
      // Unrecognized-but-numeric metric types passed through verbatim (slugged
      // names, finite numbers) — future PowerPlug data lands here automatically.
      extra: ring.extra && Object.keys(ring.extra).length ? ring.extra : null,
      home: home
        ? {
            aqi: home.aqi,
            voc: home.voc,
            hcho: home.hcho,
            co: home.co,
            co2: home.co2,
            pm1: home.pm1,
            pm25: home.pm25,
            pm10: home.pm10,
            temp_c: home.tempC,
            humidity: home.humidity,
            noise: home.noise,
            light: home.light,
            uv: home.uv,
          }
        : null,
    },
    // Secondary sources — normalized to { connected, sleep, activity, vitals, extra }
    // by their adapters, or null when not connected.
    withings,
    fitbit,
    polar,
    samsung,
    // Wyze body composition — its own category: { connected, carried_forward, measured_date, body }
    wyze,
    // Healthy habits pushed via /ingest/habits — flat { name: 0|1|quantity } or null.
    habits,
    trends,
  };
}
