// Voice notes ("rambles") dictated from the Pebble (pebble-rambles/).
// Stored per-day in KV under rambles_<date>; the exporter appends them into
// the vault's Rambles folder, routed into sections by category.

const MAX_TEXT = 2000;
const MAX_PER_DAY = 200;

export const CATEGORIES = ['ramble', 'todo', 'important', 'idea', 'question'];

// Leading spoken keywords → category. The keyword itself is stripped from the
// note ("to do buy milk" files "- [ ] buy milk" under To Do).
const KEYWORDS = [
  [/^(?:to[\s-]?do|task)\b[\s,:.!-]*/i, 'todo'],
  [/^(?:important|remember)\b[\s,:.!-]*/i, 'important'],
  [/^idea\b[\s,:.!-]*/i, 'idea'],
  [/^question\b[\s,:.!-]*/i, 'question'],
];

// Pure routing: keyword detection + stripping. An explicit valid category
// (the watch lets you override with UP/DOWN) wins, but the keyword is still
// stripped so "important call mom" never reads "important important...".
export function routeRamble(rawText, requestedCategory = null) {
  let text = String(rawText || '').trim();
  let category = CATEGORIES.includes(requestedCategory) ? requestedCategory : null;
  for (const [re, cat] of KEYWORDS) {
    const m = text.match(re);
    if (m) {
      text = text.slice(m[0].length).trim();
      if (!category) category = cat;
      break;
    }
  }
  if (!text) return null;
  return { category: category || 'ramble', text: text.slice(0, MAX_TEXT) };
}

export async function ingest(env, date, body) {
  const routed = routeRamble(body?.text, typeof body?.category === 'string' ? body.category : null);
  if (!routed) return null;
  const key = `rambles_${date}`;
  const items = (await env.KV_STORE.get(key, { type: 'json' })) || [];
  if (items.length >= MAX_PER_DAY) return null;
  const ts = Number(body.ts) || Date.now();
  const item = { id: String(ts) + '-' + items.length, ts, ...routed };
  items.push(item);
  await env.KV_STORE.put(key, JSON.stringify(items));
  return item;
}

export async function listDays(env, dates) {
  const lists = await Promise.all(
    dates.map((d) => env.KV_STORE.get(`rambles_${d}`, { type: 'json' })),
  );
  const out = {};
  dates.forEach((d, i) => { out[d] = lists[i] || []; });
  return out;
}
