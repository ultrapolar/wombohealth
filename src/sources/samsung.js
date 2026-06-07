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
//   "vitals":   { "rhr": 55, "spo2": 97, "hrv": 40 }
// }

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

export async function ingest(env, date, body) {
  await env.KV_STORE.put(`samsung_${date}`, JSON.stringify(body));
}
