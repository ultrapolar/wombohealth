// Samsung Galaxy Watch / Samsung Health adapter.
// Samsung has NO official cloud API, so there's nothing to OAuth into. Instead an
// on-device Android "Health Connect" bridge (e.g. an HTTP Shortcuts / Tasker /
// MacroDroid automation, or a small companion app) POSTs a day's metrics to
//   POST /ingest/samsung?date=YYYY-MM-DD   (header X-Export-Key)
// in the normalized shape below; we stash it in KV and read it back here.
//
// Expected POST body (all fields optional):
// {
//   "date": "2026-05-30",
//   "sleep":    { "score": 80, "duration_min": 430, "deep_min": 70, "rem_min": 95, "light_min": 250, "awake_min": 15 },
//   "activity": { "steps": 9000, "active_min": 45, "calories": 2300 },
//   "vitals":   { "rhr": 55, "spo2": 97, "hrv": 40 },
//   "extra":    { "antioxidant_index": 64, "energy_score": 82, "ages_index": 45, "stress": 30, "skin_temp_c": 33.1 }
// }
//
// On the "extra" wellness group: sleep/activity/vitals can be read from Health
// Connect (Samsung Health syncs them there), but Samsung's proprietary scores —
// Antioxidant Index (Watch 8 / One UI 8 Watch carotenoid measurement), Energy
// Score, AGEs Index — are NOT Health Connect data types; they live only in the
// Samsung Health app (the partner-gated Samsung Health Data SDK exposes some).
// They're accepted here so a manual one-tap widget — or a future bridge — can
// log them; the exporter writes them as samsung_<key> frontmatter and the
// dashboard plugin picks them up as dynamic metrics.

import { coerceNum } from '../lib/util.js';

export const id = 'samsung';

export function normalize(raw) {
  if (!raw) return null;
  return {
    connected: true,
    sleep: raw.sleep || null,
    activity: raw.activity || null,
    vitals: raw.vitals || null,
    extra: raw.extra || {},
  };
}

export async function getDay(env, date) {
  const raw = await env.KV_STORE.get(`samsung_${date}`, { type: 'json' });
  return normalize(raw);
}

// Allowlist of accepted numeric fields per group. Anything else is dropped, so a
// pushed payload can never inject markup/YAML into the vault downstream.
const NUM_FIELDS = {
  sleep: ['score', 'duration_min', 'deep_min', 'rem_min', 'light_min', 'awake_min'],
  activity: ['steps', 'active_min', 'calories', 'distance_m'],
  vitals: ['rhr', 'spo2', 'hrv', 'breathing_rate'],
  extra: ['antioxidant_index', 'energy_score', 'ages_index', 'stress', 'skin_temp_c'],
};

export function sanitize(body) {
  const out = {};
  for (const [group, keys] of Object.entries(NUM_FIELDS)) {
    const src = body?.[group];
    if (!src || typeof src !== 'object') continue;
    const clean = {};
    for (const k of keys) {
      const n = coerceNum(src[k]);
      if (n !== undefined) clean[k] = n;
    }
    if (Object.keys(clean).length) out[group] = clean;
  }
  return out;
}

// Merge per field within each group, so the morning Health Connect push and an
// afternoon wellness-widget POST ({"extra": {...}}) compose instead of the
// later one replacing the whole day. Same eventual-consistency caveat as
// habits ingest: batch into one POST when posting in quick succession.
export async function ingest(env, date, body) {
  const clean = sanitize(body);
  const existing = (await env.KV_STORE.get(`samsung_${date}`, { type: 'json' })) || {};
  const merged = { ...existing };
  for (const [group, fields] of Object.entries(clean)) {
    merged[group] = { ...(existing[group] || {}), ...fields };
  }
  await env.KV_STORE.put(`samsung_${date}`, JSON.stringify(merged));
  return merged;
}
