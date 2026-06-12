// Cloudflare Worker entry. Routes (all key-gated unless noted):
//   GET  /                  -> flat display payload TRMNL polls (cached ~2 min; see PUBLIC_DISPLAY)
//   GET  /json?date=        -> structured unified model, all sources
//   GET  /status            -> which sources are configured/connected
//   GET  /debug/raw?date=   -> raw Ultrahuman responses, to confirm the Home schema
//   GET  /connect/:source   -> begin OAuth for withings|fitbit|polar (issues a one-time state)
//   GET  /callback/:source  -> OAuth redirect target; verifies the state, stores tokens (public by necessity)
//   POST /ingest/samsung    -> on-device bridge pushes a day's metrics (sanitized to numbers)
//   POST /ingest/habits     -> one-tap phone widget logs healthy habits (slugged names, numbers only)
import { localDateStr, addDays, weeklyChart, trend, isValidDate, timingSafeEqual } from './lib/util.js';
import { fetchRing, fetchHome, ringIsEmpty, ringHasData, emptyRing, fetchRaw, RING_URL, HOME_URL } from './sources/ultrahuman.js';
import { buildUnified } from './aggregate.js';
import { buildDisplay } from './display.js';
import { htmlPage, randomState, saveState, consumeState } from './lib/oauth.js';
import * as withings from './sources/withings.js';
import * as fitbit from './sources/fitbit.js';
import * as polar from './sources/polar.js';
import * as samsung from './sources/samsung.js';
import * as wyze from './sources/wyze.js';
import * as habits from './sources/habits.js';

const AUDIT_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const DISPLAY_TTL_MS = 120 * 1000;                 // server-side cache for "/" (caps upstream fan-out)
const MAX_INGEST_BYTES = 16 * 1024;
const OAUTH = { withings, fitbit, polar };          // Samsung is ingest-only

export default {
  async fetch(request, env, ctx) {
    try {
      if (!env.KV_STORE) throw new Error('Missing KV_STORE binding');
      if (!env.API_TOKEN) throw new Error('Missing API_TOKEN secret');

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const seg = path.split('/').filter(Boolean);
      const token = env.API_TOKEN;
      const tz = env.USER_TIMEZONE || null;
      const offset = parseFloat(env.USER_TZ_OFFSET ?? '0');
      const stepGoal = parseInt(env.STEP_GOAL ?? '10000', 10);
      const homeEnabled = (env.HOME_ENABLED ?? 'true') !== 'false';
      const exportKey = env.EXPORT_KEY || null;
      const now = new Date();
      const todayStr = localDateStr(now, tz, offset);

      const keyOk = () => {
        if (!exportKey) return false;
        const k = url.searchParams.get('key') || request.headers.get('x-export-key') || '';
        return timingSafeEqual(k, exportKey);
      };
      // Resolve a caller-supplied date, rejecting anything that isn't a real YYYY-MM-DD.
      const validDate = (raw) => {
        const d = raw || todayStr;
        return isValidDate(d) ? d : null;
      };

      // --- OAuth: begin connect (key-gated; issues a one-time CSRF state) ---
      if (seg[0] === 'connect' && seg[1]) {
        const a = OAUTH[seg[1]];
        if (!a) return json({ error: 'unknown source' }, 404);
        if (!keyOk()) return json({ error: 'unauthorized' }, 401);
        if (!a.configured(env)) {
          const U = seg[1].toUpperCase();
          return htmlPage('Not configured',
            `<p>Set <code>${U}_CLIENT_ID</code> and <code>${U}_CLIENT_SECRET</code> on the Worker, then retry.</p>`, 400);
        }
        const state = randomState();
        await saveState(env, state, seg[1]);
        return Response.redirect(a.authUrl(env, `${url.origin}/callback/${seg[1]}`, state), 302);
      }

      // --- OAuth: redirect target. Public (the provider redirects here), but a valid
      //     state — only mintable via an authorized /connect — is required to proceed. ---
      if (seg[0] === 'callback' && seg[1]) {
        const a = OAUTH[seg[1]];
        if (!a) return json({ error: 'unknown source' }, 404);
        if (url.searchParams.get('error')) {
          console.error(`OAuth ${seg[1]} denied:`, url.searchParams.get('error'));
          return htmlPage('Authorization failed', '<p>The provider denied authorization. Retry from /connect.</p>', 400);
        }
        const code = url.searchParams.get('code');
        if (!code) return htmlPage('Missing code', '<p>No authorization code returned.</p>', 400);
        if ((await consumeState(env, url.searchParams.get('state') || '')) !== seg[1]) {
          return htmlPage('Invalid request', '<p>Missing or expired state. Please retry from /connect.</p>', 400);
        }
        await a.exchangeCode(env, code, `${url.origin}/callback/${seg[1]}`);
        return htmlPage('Connected', `<p><b>${seg[1]}</b> is now linked. You can close this tab.</p>`);
      }

      // --- status: which sources are configured/connected ---
      if (path === '/status') {
        if (!keyOk()) return json({ error: 'unauthorized' }, 401);
        const out = { date: todayStr, ultrahuman: { connected: !!env.API_TOKEN, home: homeEnabled } };
        for (const k of Object.keys(OAUTH)) {
          out[k] = { configured: OAUTH[k].configured(env), connected: !!(await env.KV_STORE.get(`oauth_${k}`)) };
        }
        out.samsung = { ingested_today: !!(await env.KV_STORE.get(`samsung_${todayStr}`)) };
        out.wyze = { last_weigh_in: (await env.KV_STORE.get('wyze_latest', { type: 'json' }))?.date || null };
        out.habits = { logged_today: Object.keys((await habits.getDay(env, todayStr)) || {}) };
        return json(out);
      }

      // --- Push ingest routes (sanitized, size-capped, key-gated) ---
      // Each adapter's ingest() drops everything but allowlisted/slugged numbers.
      if (seg[0] === 'ingest' && seg[1]) {
        const adapter = { samsung, wyze, habits }[seg[1]];
        if (!adapter) return json({ error: 'unknown source' }, 404);
        if (!keyOk()) return json({ error: 'unauthorized' }, 401);
        if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
        if (Number(request.headers.get('content-length') || 0) > MAX_INGEST_BYTES) {
          return json({ error: 'body too large' }, 413);
        }
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object') return json({ error: 'invalid JSON body' }, 400);
        const date = validDate(url.searchParams.get('date') || body.date);
        if (!date) return json({ error: 'invalid date (YYYY-MM-DD)' }, 400);
        const stored = await adapter.ingest(env, date, body);
        // habits/samsung ingest return the merged record they wrote; echo it.
        return json(stored ? { ok: true, date, stored } : { ok: true, date });
      }

      // --- debug: raw Ultrahuman responses (to finalize the Home schema) ---
      if (path === '/debug/raw') {
        if (!keyOk()) return json({ error: 'unauthorized' }, 401);
        const date = validDate(url.searchParams.get('date'));
        if (!date) return json({ error: 'invalid date (YYYY-MM-DD)' }, 400);
        const [ringRaw, homeRaw] = await Promise.all([fetchRaw(RING_URL, date, token), fetchRaw(HOME_URL, date, token)]);
        return json({ date, ring: summarizeRaw(ringRaw), home: summarizeRaw(homeRaw) });
      }

      // --- structured unified model (drives the Obsidian exporter) ---
      if (path === '/json') {
        if (!keyOk()) return json({ error: 'unauthorized' }, 401);
        const date = validDate(url.searchParams.get('date'));
        if (!date) return json({ error: 'invalid date (YYYY-MM-DD)' }, 400);
        return json(await getDayUnified(date, env, token, homeEnabled), 200, { 'Cache-Control': 'no-store' });
      }

      // --- TRMNL display. Key-gated by default; set PUBLIC_DISPLAY="true" to open it.
      //     Served from a short server-side cache so polling can't amplify upstream calls. ---
      if (path === '/') {
        if (env.PUBLIC_DISPLAY !== 'true' && !keyOk()) return json({ error: 'unauthorized' }, 401);
        const cached = await env.KV_STORE.get('display_cache', { type: 'json' });
        if (cached && Date.now() - cached.ts < DISPLAY_TTL_MS) {
          return json(cached.payload, 200, { 'Cache-Control': 'private, max-age=120' });
        }
        const payload = await buildDisplayPayload(env, ctx, { token, tz, stepGoal, homeEnabled, now, todayStr });
        ctx.waitUntil(env.KV_STORE.put('display_cache', JSON.stringify({ ts: Date.now(), payload })));
        return json(payload, 200, { 'Cache-Control': 'private, max-age=120' });
      }

      return json({ error: 'not found', path }, 404);
    } catch (e) {
      console.error('worker error:', e?.stack || e);
      return json({ error: 'internal error' }, 500); // never leak internals to the caller
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

async function getRing(env, date, token) {
  let ring = await env.KV_STORE.get(`ring_${date}`, { type: 'json' });
  if (!ring) {
    ring = await fetchRing(date, token);
    // Cache any day with data — including CGM/extras-only days where the ring
    // itself hasn't synced (ringIsEmpty would call those empty).
    if (ringHasData(ring)) await env.KV_STORE.put(`ring_${date}`, JSON.stringify(ring));
  }
  return ring;
}

async function getHome(env, date, token, homeEnabled) {
  if (!homeEnabled) return null;
  let home = await env.KV_STORE.get(`home_${date}`, { type: 'json' });
  if (!home) {
    home = await fetchHome(date, token);
    await env.KV_STORE.put(`home_${date}`, JSON.stringify(home));
  }
  return home;
}

// Structured unified model for an arbitrary date.
async function getDayUnified(date, env, token, homeEnabled) {
  const ring = (await getRing(env, date, token)) || emptyRing();
  const home = await getHome(env, date, token, homeEnabled);
  const secondary = await gatherSecondary(env, date);
  secondary.habits = await habits.getDay(env, date);
  const yRing = (await env.KV_STORE.get(`ring_${addDays(date, -1)}`, { type: 'json' })) || {};
  const trends = {
    hrv: trend(ring.hrv, yRing.hrv).dir,
    rhr: trend(ring.rhr, yRing.rhr).dir,
    steps: trend(ring.steps, yRing.steps).dir,
  };
  return buildUnified({ date, ring, home, ...secondary, trends, stale: ringIsEmpty(ring) });
}

// Flat TRMNL payload for "today" (yesterday-fallback + audit + weekly chart).
async function buildDisplayPayload(env, ctx, { token, tz, stepGoal, homeEnabled, now, todayStr }) {
  const lastAudit = parseInt((await env.KV_STORE.get('last_audit_run')) || '0', 10);
  const history = (await env.KV_STORE.get('step_history', { type: 'json' })) || {};
  if (Date.now() - lastAudit > AUDIT_INTERVAL_MS || Object.keys(history).length < 2) {
    ctx.waitUntil(runAudit(todayStr, env, token));
  }

  let ring = await fetchRing(todayStr, token);
  let stale = false;
  if (ringIsEmpty(ring)) {
    const y = addDays(todayStr, -1);
    ring = (await env.KV_STORE.get(`ring_${y}`, { type: 'json' })) || (await fetchRing(y, token));
    stale = true;
  }
  const home = homeEnabled ? await fetchHome(todayStr, token) : null;
  const sources = await gatherSecondary(env, todayStr);

  history[todayStr] = ring.steps;
  ctx.waitUntil(env.KV_STORE.put('step_history', JSON.stringify(history)));
  // Never cache the yesterday-fallback under today's key — it would poison
  // /json for the whole day with yesterday's numbers (incl. glucose/extras).
  if (!stale) ctx.waitUntil(env.KV_STORE.put(`ring_${todayStr}`, JSON.stringify(ring)));

  const yRing = (await env.KV_STORE.get(`ring_${addDays(todayStr, -1)}`, { type: 'json' })) || {};
  const hrvTrend = trend(ring.hrv, yRing.hrv).icon;
  const chart = weeklyChart(history, todayStr, stepGoal);
  const lastUpdated = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz || 'UTC',
  }).format(now);

  return buildDisplay({ ring, home, chart, hrvTrend, lastUpdated, homeEnabled, stale, sources });
}

// Background backfill of the last 7 days (history + per-day ring cache).
async function runAudit(todayStr, env, token) {
  const dates = [];
  for (let i = 1; i <= 7; i++) dates.push(addDays(todayStr, -i));
  const rings = await Promise.all(dates.map((d) => fetchRing(d, token)));
  const history = (await env.KV_STORE.get('step_history', { type: 'json' })) || {};
  for (let i = 0; i < dates.length; i++) {
    history[dates[i]] = rings[i].steps;
    await env.KV_STORE.put(`ring_${dates[i]}`, JSON.stringify(rings[i]));
  }
  await env.KV_STORE.put('step_history', JSON.stringify(history));
  await env.KV_STORE.put('last_audit_run', Date.now().toString());
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
