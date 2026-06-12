// Healthy-habits adapter (ingest-only, like Samsung). There's no wearable here:
// the user logs habits from their phone — a one-tap HTTP Shortcuts / Tasker /
// MacroDroid widget POSTs completions to
//   POST /ingest/habits?date=YYYY-MM-DD   (header X-Export-Key)
// We stash them in KV; /json carries them and the exporter writes `habit_<name>`
// frontmatter into Health/<date>.md, where the dashboard plugin's Habits tab and
// Dataview both pick them up.
//
// Accepted POST bodies (mix and match; the `habits` object wins over `done` for
// the same name since it's processed last):
//   { "date": "2026-06-11", "done": ["supplements", "meditation"] }
//   { "date": "2026-06-11", "habits": { "intentional_walk": 1, "walk_min": 25, "alcohol": 0 } }
//
// Unlike samsung/wyze, ingest MERGES with the day's existing entry (per-key, last
// write wins) so each habit can be posted by its own button as the day goes on.
// Caveat: the merge is a read-modify-write on eventually-consistent KV, so two
// POSTs landing within the propagation window on different PoPs can lose one
// update. For taps seconds apart on the same phone this is fine in practice;
// batch multiple habits into one POST when you can.
import { slugKey, coerceNum } from '../lib/util.js';

export const id = 'habits';

const MAX_HABITS = 50; // cap per stored day, not just per request
const MAX_VALUE = 100000;

function num(v) {
  const n = coerceNum(v);
  return n === undefined ? undefined : Math.max(0, Math.min(MAX_VALUE, n));
}

export function sanitize(body) {
  const out = {};
  const add = (name, value) => {
    const k = slugKey(name);
    const v = num(value);
    if (!k || v === undefined) return;
    // Updates to already-present keys are always allowed; only NEW keys count
    // against the cap (so a re-posted correction is never silently dropped).
    if (!(k in out) && Object.keys(out).length >= MAX_HABITS) return;
    out[k] = v;
  };
  const done = body?.done;
  const list = Array.isArray(done) ? done : typeof done === 'string' ? done.split(',') : [];
  for (const name of list) add(name, 1);
  if (body?.habits && typeof body.habits === 'object' && !Array.isArray(body.habits)) {
    for (const [name, value] of Object.entries(body.habits)) add(name, value);
  }
  return out;
}

export async function getDay(env, date) {
  const raw = await env.KV_STORE.get(`habits_${date}`, { type: 'json' });
  if (!raw || typeof raw !== 'object') return null;
  return Object.keys(raw).length ? raw : null;
}

// Merge into the day's record and return what was stored. Existing keys are
// kept preferentially when the cap is hit, so the record can't grow unbounded
// across many POSTs.
export async function ingest(env, date, body) {
  const clean = sanitize(body);
  const existing = (await env.KV_STORE.get(`habits_${date}`, { type: 'json' })) || {};
  const merged = { ...existing };
  for (const [k, v] of Object.entries(clean)) {
    if (k in merged || Object.keys(merged).length < MAX_HABITS) merged[k] = v;
  }
  await env.KV_STORE.put(`habits_${date}`, JSON.stringify(merged));
  return merged;
}
