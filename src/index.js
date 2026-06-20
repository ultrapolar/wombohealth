// Cloudflare Worker entry. Routes (all key-gated unless noted):
//   GET  /                  -> flat display payload TRMNL polls (cached ~2 min; see PUBLIC_DISPLAY)
//   GET  /json?date=        -> structured unified model, all sources
//   GET  /status            -> which sources are configured/connected
//   GET  /debug/raw?date=   -> raw Ultrahuman responses, to confirm the Home schema
//   GET  /connect/:source   -> begin OAuth for withings|fitbit|polar (issues a one-time state)
//   GET  /callback/:source  -> OAuth redirect target; verifies the state, stores tokens (public by necessity)
//   POST /ingest/samsung    -> on-device bridge pushes a day's metrics (sanitized to numbers)
//   POST /ingest/wyze       -> Wyze scale ingest
import { Router } from 'itty-router';
import { localDateStr, addDays, weeklyChart, trend, isValidDate, timingSafeEqual } from './lib/util.js';
import { fetchRing, fetchHome, ringIsEmpty, emptyRing, fetchRaw, RING_URL, HOME_URL } from './sources/ultrahuman.js';
import { buildUnified } from './aggregate.js';
import { buildDisplay } from './display.js';
import { htmlPage, randomState, saveState, consumeState } from './lib/oauth.js';
import * as withings from './sources/withings.js';
import * as fitbit from './sources/fitbit.js';
import * as polar from './sources/polar.js';
import * as samsung from './sources/samsung.js';
import * as wyze from './sources/wyze.js';

const AUDIT_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const DISPLAY_TTL_MS = 120 * 1000;                 // server-side cache for "/" (caps upstream fan-out)
const MAX_INGEST_BYTES = 16 * 1024;
const OAUTH = { withings, fitbit, polar };          // Samsung is ingest-only

const router = Router();

// --- Globals for caching ---
const memCache = new Map();

async function kvGet(env, key, options = { type: 'text' }) {
  const cacheKey = `${key}:${options.type}`;
  if (memCache.has(cacheKey)) return memCache.get(cacheKey);
  const val = await env.KV_STORE.get(key, options);
  if (val !== null && val !== undefined) {
    memCache.set(cacheKey, val);
  }
  return val;
}

function kvPut(env, ctx, key, value) {
  memCache.set(`${key}:text`, value);
  try { memCache.set(`${key}:json`, JSON.parse(value)); } catch (e) {}
  ctx.waitUntil(env.KV_STORE.put(key, value));
}

// Middleware: extract env/config and validate key
const withContext = (request, env, ctx) => {
  request.token = env.API_TOKEN;
  request.tz = env.USER_TIMEZONE || null;
  request.offset = parseFloat(env.USER_TZ_OFFSET ?? '0');
  request.stepGoal = parseInt(env.STEP_GOAL ?? '10000', 10);
  request.homeEnabled = (env.HOME_ENABLED ?? 'true') !== 'false';
  request.exportKey = env.EXPORT_KEY || null;
  request.now = new Date();
  request.todayStr = localDateStr(request.now, request.tz, request.offset);

  const url = new URL(request.url);
  request.urlObj = url;
  
  request.keyOk = () => {
    if (!request.exportKey) return false;
    const k = url.searchParams.get('key') || request.headers.get('x-export-key') || '';
    return timingSafeEqual(k, request.exportKey);
  };

  request.validDate = (raw) => {
    const d = raw || request.todayStr;
    return isValidDate(d) ? d : null;
  };
};

const requireKey = (request) => {
  if (!request.keyOk()) return json({ error: 'unauthorized' }, 401);
};

// Routes
router.all('*', withContext);

router.get('/connect/:source', requireKey, async (request, env) => {
  const { source } = request.params;
  const a = OAUTH[source];
  if (!a) return json({ error: 'unknown source' }, 404);
  if (!a.configured(env)) {
    const U = source.toUpperCase();
    return htmlPage('Not configured',
      `<p>Set <code>${U}_CLIENT_ID</code> and <code>${U}_CLIENT_SECRET</code> on the Worker, then retry.</p>`, 400);
  }
  const state = randomState();
  await saveState(env, state, source);
  return Response.redirect(a.authUrl(env, `${request.urlObj.origin}/callback/${source}`, state), 302);
});

router.get('/callback/:source', async (request, env) => {
  const { source } = request.params;
  const a = OAUTH[source];
  if (!a) return json({ error: 'unknown source' }, 404);
  if (request.urlObj.searchParams.get('error')) {
    console.error(`OAuth ${source} denied:`, request.urlObj.searchParams.get('error'));
    return htmlPage('Authorization failed', '<p>The provider denied authorization. Retry from /connect.</p>', 400);
  }
  const code = request.urlObj.searchParams.get('code');
  if (!code) return htmlPage('Missing code', '<p>No authorization code returned.</p>', 400);
  if ((await consumeState(env, request.urlObj.searchParams.get('state') || '')) !== source) {
    return htmlPage('Invalid request', '<p>Missing or expired state. Please retry from /connect.</p>', 400);
  }
  await a.exchangeCode(env, code, `${request.urlObj.origin}/callback/${source}`);
  return htmlPage('Connected', `<p><b>${source}</b> is now linked. You can close this tab.</p>`);
});

router.get('/status', requireKey, async (request, env) => {
  const { todayStr, homeEnabled } = request;
  const out = { date: todayStr, ultrahuman: { connected: !!env.API_TOKEN, home: homeEnabled } };
  for (const k of Object.keys(OAUTH)) {
    out[k] = { configured: OAUTH[k].configured(env), connected: !!(await kvGet(env, `oauth_${k}`)) };
  }
  out.samsung = { ingested_today: !!(await kvGet(env, `samsung_${todayStr}`)) };
  out.wyze = { last_weigh_in: (await kvGet(env, 'wyze_latest', { type: 'json' }))?.date || null };
  return json(out);
});

router.post('/ingest/samsung', requireKey, async (request, env) => {
  if (Number(request.headers.get('content-length') || 0) > MAX_INGEST_BYTES) {
    return json({ error: 'body too large' }, 413);
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'invalid JSON body' }, 400);
  const date = request.validDate(request.urlObj.searchParams.get('date') || body.date);
  if (!date) return json({ error: 'invalid date (YYYY-MM-DD)' }, 400);
  await samsung.ingest(env, date, body); 
  memCache.delete(`samsung_${date}:text`);
  memCache.delete(`samsung_${date}:json`);
  return json({ ok: true, date });
});

router.post('/ingest/wyze', requireKey, async (request, env) => {
  if (Number(request.headers.get('content-length') || 0) > MAX_INGEST_BYTES) {
    return json({ error: 'body too large' }, 413);
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object') return json({ error: 'invalid JSON body' }, 400);
  const date = request.validDate(request.urlObj.searchParams.get('date') || body.date);
  if (!date) return json({ error: 'invalid date (YYYY-MM-DD)' }, 400);
  await wyze.ingest(env, date, body);
  memCache.delete(`wyze_${date}:text`);
  memCache.delete(`wyze_${date}:json`);
  memCache.delete('wyze_latest:text');
  memCache.delete('wyze_latest:json');
  return json({ ok: true, date });
});

router.get('/debug/raw', requireKey, async (request, env) => {
  const date = request.validDate(request.urlObj.searchParams.get('date'));
  if (!date) return json({ error: 'invalid date (YYYY-MM-DD)' }, 400);
  const [ringRaw, homeRaw] = await Promise.all([fetchRaw(RING_URL, date, request.token), fetchRaw(HOME_URL, date, request.token)]);
  return json({ date, ring: summarizeRaw(ringRaw), home: summarizeRaw(homeRaw) });
});

router.get('/json', requireKey, async (request, env, ctx) => {
  const date = request.validDate(request.urlObj.searchParams.get('date'));
  if (!date) return json({ error: 'invalid date (YYYY-MM-DD)' }, 400);
  return json(await getDayUnified(date, env, ctx, request.token, request.homeEnabled), 200, { 'Cache-Control': 'no-store' });
});

router.get('/', async (request, env, ctx) => {
  if (env.PUBLIC_DISPLAY !== 'true' && !request.keyOk()) return json({ error: 'unauthorized' }, 401);
  const cached = await kvGet(env, 'display_cache', { type: 'json' });
  if (cached && Date.now() - cached.ts < DISPLAY_TTL_MS) {
    return json(cached.payload, 200, { 'Cache-Control': 'private, max-age=120' });
  }
  const payload = await buildDisplayPayload(env, ctx, { 
    token: request.token, tz: request.tz, stepGoal: request.stepGoal, 
    homeEnabled: request.homeEnabled, now: request.now, todayStr: request.todayStr 
  });
  kvPut(env, ctx, 'display_cache', JSON.stringify({ ts: Date.now(), payload }));
  return json(payload, 200, { 'Cache-Control': 'private, max-age=120' });
});

router.all('*', () => json({ error: 'not found' }, 404));

export default {
  async fetch(request, env, ctx) {
    try {
      if (!env.KV_STORE) throw new Error('Missing KV_STORE binding');
      if (!env.API_TOKEN) throw new Error('Missing API_TOKEN secret');
      return await router.fetch(request, env, ctx);
    } catch (e) {
      console.error('worker error:', e?.stack || e);
      return json({ error: 'internal error' }, 500); 
    }
  },
};

// --- source gathering (shared by / and /json) ---

async function safeGet(adapter, env, date) {
  try {
    return await adapter.getDay(env, date);
  } catch (e) {
    console.error(`${adapter.id} getDay failed for ${date}: ${e.message}`);
    return null;
  }
}

async function gatherSecondary(env, date) {
  const [w, f, p, s, wy] = await Promise.all(
    [withings, fitbit, polar, samsung, wyze].map((a) => safeGet(a, env, date)),
  );
  return { withings: w, fitbit: f, polar: p, samsung: s, wyze: wy };
}

async function getRing(env, ctx, date, token) {
  let ring = await kvGet(env, `ring_${date}`, { type: 'json' });
  if (!ring) {
    ring = await fetchRing(date, token);
    if (!ringIsEmpty(ring)) kvPut(env, ctx, `ring_${date}`, JSON.stringify(ring));
  }
  return ring;
}

async function getHome(env, ctx, date, token, homeEnabled) {
  if (!homeEnabled) return null;
  let home = await kvGet(env, `home_${date}`, { type: 'json' });
  if (!home) {
    home = await fetchHome(date, token);
    kvPut(env, ctx, `home_${date}`, JSON.stringify(home));
  }
  return home;
}

async function getDayUnified(date, env, ctx, token, homeEnabled) {
  const ring = (await getRing(env, ctx, date, token)) || emptyRing();
  const home = await getHome(env, ctx, date, token, homeEnabled);
  const secondary = await gatherSecondary(env, date);
  const yRing = (await kvGet(env, `ring_${addDays(date, -1)}`, { type: 'json' })) || {};
  const trends = {
    hrv: trend(ring.hrv, yRing.hrv).dir,
    rhr: trend(ring.rhr, yRing.rhr).dir,
    steps: trend(ring.steps, yRing.steps).dir,
  };
  return buildUnified({ date, ring, home, ...secondary, trends, stale: ringIsEmpty(ring) });
}

async function buildDisplayPayload(env, ctx, { token, tz, stepGoal, homeEnabled, now, todayStr }) {
  const lastAudit = parseInt((await kvGet(env, 'last_audit_run')) || '0', 10);
  const history = (await kvGet(env, 'step_history', { type: 'json' })) || {};
  if (Date.now() - lastAudit > AUDIT_INTERVAL_MS || Object.keys(history).length < 2) {
    ctx.waitUntil(runAudit(todayStr, env, token, ctx));
  }

  let ring = await fetchRing(todayStr, token);
  let stale = false;
  if (ringIsEmpty(ring)) {
    const y = addDays(todayStr, -1);
    ring = (await kvGet(env, `ring_${y}`, { type: 'json' })) || (await fetchRing(y, token));
    stale = true;
  }
  const home = homeEnabled ? await fetchHome(todayStr, token) : null;
  const sources = await gatherSecondary(env, todayStr);

  history[todayStr] = ring.steps;
  kvPut(env, ctx, 'step_history', JSON.stringify(history));
  kvPut(env, ctx, `ring_${todayStr}`, JSON.stringify(ring));

  const yRing = (await kvGet(env, `ring_${addDays(todayStr, -1)}`, { type: 'json' })) || {};
  const hrvTrend = trend(ring.hrv, yRing.hrv).icon;
  const chart = weeklyChart(history, todayStr, stepGoal);
  const lastUpdated = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz || 'UTC',
  }).format(now);

  return buildDisplay({ ring, home, chart, hrvTrend, lastUpdated, homeEnabled, stale, sources });
}

async function runAudit(todayStr, env, token, ctx) {
  const dates = [];
  for (let i = 1; i <= 7; i++) dates.push(addDays(todayStr, -i));
  const rings = await Promise.all(dates.map((d) => fetchRing(d, token)));
  const history = (await kvGet(env, 'step_history', { type: 'json' })) || {};
  
  let anomalyDetected = false;
  for (let i = 0; i < dates.length; i++) {
    history[dates[i]] = rings[i].steps;
    kvPut(env, ctx, `ring_${dates[i]}`, JSON.stringify(rings[i]));
    if (rings[i].steps === 0) anomalyDetected = true;
  }
  kvPut(env, ctx, 'step_history', JSON.stringify(history));
  kvPut(env, ctx, 'last_audit_run', Date.now().toString());

  const wyzeLatest = await kvGet(env, 'wyze_latest', { type: 'json' });
  let wyzeExpired = false;
  if (wyzeLatest && wyzeLatest.measured_at) {
    const ms = wyzeLatest.measured_at < 1e12 ? wyzeLatest.measured_at * 1000 : wyzeLatest.measured_at;
    const daysSince = (Date.now() - ms) / (24 * 60 * 60 * 1000);
    if (daysSince > 14) wyzeExpired = true;
  }

  const alerts = [];
  if (anomalyDetected) alerts.push("Anomaly detected: 0 steps recorded on one or more past days during audit.");
  if (wyzeExpired) alerts.push("Wyze token expiration alert: No weigh-in data received in the last 14 days.");

  if (alerts.length > 0 && env.DISCORD_WEBHOOK) {
    ctx.waitUntil(fetch(env.DISCORD_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: alerts.join('\n') })
    }).catch(e => console.error('Discord webhook failed', e)));
  }
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

function summarizeRaw(raw) {
  if (!raw?.ok) return { ok: false, status: raw?.status, body: raw?.body?.slice?.(0, 4000) };
  try {
    return JSON.parse(raw.body);
  } catch {
    return { ok: true, status: raw.status, note: 'non-JSON body', body: raw.body?.slice?.(0, 4000) };
  }
}
