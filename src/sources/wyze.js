// Wyze smart scale (body composition). Like Samsung, Wyze has no official cloud
// API, so a LOCAL Python puller (exporter/wyze_pull.py, via the reverse-engineered
// wyze-sdk) POSTs each weigh-in to POST /ingest/wyze and we read it back here.
//
// Body composition is a distinct metric *category* (not sleep/activity/vitals), and
// weigh-ins are sparse — so we keep the latest record and carry it forward to fill
// gap days, flagged so the display/export can say "as of <date>" honestly.
//
// Expected POST body: { date: "YYYY-MM-DD", measured_at: <epoch seconds>, body: {
//   weight_kg, weight_lb, bmi, body_fat_pct, muscle_mass_kg, body_water_pct,
//   bmr_kcal, visceral_fat, bone_mass_kg, metabolic_age, protein_pct } }

import { coerceNum } from '../lib/util.js';

export const id = 'wyze';

const STALE_MS = 21 * 24 * 60 * 60 * 1000; // don't carry a weigh-in forward longer than this

// Allowlisted numeric fields — everything else is dropped, so a pushed payload can
// never inject markup/YAML into the vault (same rationale as Samsung).
const BODY_FIELDS = [
  'weight_kg', 'weight_lb', 'bmi', 'body_fat_pct', 'muscle_mass_kg', 'body_water_pct',
  'bmr_kcal', 'visceral_fat', 'bone_mass_kg', 'metabolic_age', 'protein_pct',
];

const num = coerceNum;

export function sanitize(payload) {
  const src = payload?.body && typeof payload.body === 'object' ? payload.body : payload;
  const body = {};
  for (const k of BODY_FIELDS) {
    const n = num(src?.[k]);
    if (n !== undefined) body[k] = n;
  }
  return { body, measured_at: num(payload?.measured_at) ?? null };
}

export async function ingest(env, date, payload) {
  const clean = sanitize(payload);
  if (!Object.keys(clean.body).length) return; // nothing usable
  const record = { date, body: clean.body, measured_at: clean.measured_at };
  await env.KV_STORE.put(`wyze_${date}`, JSON.stringify(record));
  await env.KV_STORE.put('wyze_latest', JSON.stringify(record));
}

function shape(record, carried) {
  return {
    connected: true,
    carried_forward: carried,
    measured_date: record.date,
    measured_at: record.measured_at,
    body: record.body,
  };
}

export async function getDay(env, date) {
  const exact = await env.KV_STORE.get(`wyze_${date}`, { type: 'json' });
  if (exact) return shape(exact, false);

  const latest = await env.KV_STORE.get('wyze_latest', { type: 'json' });
  if (!latest) return null;
  if (latest.measured_at) {
    const ms = latest.measured_at < 1e12 ? latest.measured_at * 1000 : latest.measured_at; // epoch s or ms
    if (Date.now() - ms > STALE_MS) return null; // too old to claim as "current"
  }
  return shape(latest, true);
}
