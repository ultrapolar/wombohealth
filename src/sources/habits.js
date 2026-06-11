// Healthy-habits adapter (ingest-only, like Samsung). There's no wearable here:
// the user logs habits from their phone — a one-tap HTTP Shortcuts / Tasker /
// MacroDroid widget POSTs completions to
//   POST /ingest/habits?date=YYYY-MM-DD   (header X-Export-Key)
// We stash them in KV; /json carries them and the exporter writes `habit_<name>`
// frontmatter into Health/<date>.md, where the dashboard plugin's Habits tab and
// Dataview both pick them up.
//
// Accepted POST bodies (mix and match):
//   { "date": "2026-06-11", "done": ["supplements", "meditation"] }
//   { "date": "2026-06-11", "habits": { "intentional_walk": 1, "walk_min": 25, "alcohol": 0 } }
//
// Unlike samsung/wyze, ingest MERGES with the day's existing entry (per-key, last
// write wins) so each habit can be posted by its own button as the day goes on.

export const id = 'habits';

const MAX_HABITS = 50;
const MAX_NAME_LEN = 40;
const MAX_VALUE = 100000;

// Habit names end up as YAML frontmatter keys in the vault, so they're reduced to
// a strict [a-z0-9_] slug — pushed payloads can never inject markup or YAML.
function slug(name) {
  const s = String(name).trim().toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, MAX_NAME_LEN);
  return /^[a-z]/.test(s) ? s : '';
}

function num(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(MAX_VALUE, n));
}

export function sanitize(body) {
  const out = {};
  let count = 0;
  const add = (name, value) => {
    const k = slug(name);
    const v = num(value);
    if (!k || v === undefined || count >= MAX_HABITS) return;
    if (!(k in out)) count++;
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

export async function ingest(env, date, body) {
  const clean = sanitize(body);
  const existing = (await env.KV_STORE.get(`habits_${date}`, { type: 'json' })) || {};
  await env.KV_STORE.put(`habits_${date}`, JSON.stringify({ ...existing, ...clean }));
}
