// Cloudflare Worker entry. Routes:
//   GET  /                  -> flat display payload TRMNL polls (Ultrahuman-centric)
//   GET  /json?date=        -> structured unified model, all sources (key-gated)
//   GET  /status            -> which sources are configured/connected (key-gated)
//   GET  /debug/raw?date=   -> raw Ultrahuman responses, to confirm the Home schema (key-gated)
//   GET  /connect/:source   -> begin OAuth for withings|fitbit|polar
//   GET  /callback/:source  -> OAuth redirect target; stores tokens in KV
//   POST /ingest/samsung    -> on-device Health Connect bridge pushes a day's metrics (key-gated)
import { localDateStr, addDays, weeklyChart, trend } from './lib/util.js';
import {
  fetchRing, fetchHome, ringIsEmpty, emptyRing, fetchRaw, RING_URL, HOME_URL,
} from './sources/ultrahuman.js';
import { buildUnified } from './aggregate.js';
import { buildDisplay } from './display.js';
import { htmlPage, randomState } from './lib/oauth.js';
import * as withings from './sources/withings.js';
import * as fitbit from './sources/fitbit.js';
import * as polar from './sources/polar.js';
import * as samsung from './sources/samsung.js';

const AUDIT_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const OAUTH = { withings, fitbit, polar }; // OAuth2 sources (Samsung is ingest-only)

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
      const keyOk = () =>
        !!exportKey &&
        (url.searchParams.get('key') === exportKey ||
          request.headers.get('x-export-key') === exportKey);

      // --- OAuth: begin connect ---
      if (seg[0] === 'connect' && seg[1]) {
        const a = OAUTH[seg[1]];
        if (!a) return json({ error: 'unknown source' }, 404);
        if (!a.configured(env)) {
          const U = seg[1].toUpperCase();
          return htmlPage('Not configured',
            `<p>Set <code>${U}_CLIENT_ID</code> and <code>${U}_CLIENT_SECRET</code> on the Worker, then retry.</p>`, 400);
        }
        const redirectUri = `${url.origin}/callback/${seg[1]}`;
        return Response.redirect(a.authUrl(env, redirectUri, randomState(seg[1])), 302);
      }

      // --- OAuth: redirect target ---
      if (seg[0] === 'callback' && seg[1]) {
        const a = OAUTH[seg[1]];
        if (!a) return json({ error: 'unknown source' }, 404);
        const err = url.searchParams.get('error');
        if (err) return htmlPage('Authorization failed', `<p>${err}: ${url.searchParams.get('error_description') || ''}</p>`, 400);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state') || '';
        if (!code) return htmlPage('Missing code', '<p>No authorization code returned.</p>', 400);
        if (!state.startsWith(`${seg[1]}.`)) return htmlPage('State mismatch', '<p>Invalid state — please retry from /connect.</p>', 400);
        await a.exchangeCode(env, code, `${url.origin}/callback/${seg[1]}`);
        return htmlPage('Connected ✓', `<p><b>${seg[1]}</b> is now linked. You can close this tab.</p>`);
      }

      // --- status (which sources are wired up) ---
      if (path === '/status') {
        if (!keyOk()) return json({ error: 'unauthorized' }, 401);
        const out = { date: todayStr, ultrahuman: { connected: !!env.API_TOKEN, home: homeEnabled } };
        for (const k of Object.keys(OAUTH)) {
          out[k] = { configured: OAUTH[k].configured(env), connected: !!(await env.KV_STORE.get(`oauth_${k}`)) };
        }
        out.samsung = { ingested_today: !!(await env.KV_STORE.get(`samsung_${todayStr}`)) };
        return json(out);
      }

      // --- Samsung ingest (pushed by an on-device bridge) ---
      if (path === '/ingest/samsung') {
        if (!keyOk()) return json({ error: 'unauthorized' }, 401);
        if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
        const body = await request.json().catch(() => null);
        if (!body) return json({ error: 'invalid JSON body' }, 400);
        const date = url.searchParams.get('date') || body.date || todayStr;
        await samsung.ingest(env, date, body);
        return json({ ok: true, date });
      }

      // --- debug: raw Ultrahuman responses (to finalize the Home schema) ---
      if (path === '/debug/raw') {
        if (!keyOk()) return json({ error: 'unauthorized' }, 401);
        const date = url.searchParams.get('date') || todayStr;
        const [ringRaw, homeRaw] = await Promise.all([
          fetchRaw(RING_URL, date, token),
          fetchRaw(HOME_URL, date, token),
        ]);
        return json({ date, ring: summarizeRaw(ringRaw), home: summarizeRaw(homeRaw) });
      }

      // --- structured unified model (drives the Obsidian exporter) ---
      if (path === '/json') {
        if (!keyOk()) return json({ error: 'unauthorized' }, 401);
        const date = url.searchParams.get('date') || todayStr;
        return json(await getDayUnified(date, env, token, homeEnabled), 200, { 'Cache-Control': 'no-store' });
      }

      // --- flat display payload for TRMNL ---
      if (path === '/') {
        const lastAudit = parseInt((await env.KV_STORE.get('last_audit_run')) || '0', 10);
        const history = (await env.KV_STORE.get('step_history', { type: 'json' })) || {};
        if (Date.now() - lastAudit > AUDIT_INTERVAL_MS || Object.keys(history).length < 2) {
          ctx.waitUntil(runAudit(todayStr, env, token));
        }

        // Today's ring, falling back to yesterday if it hasn't synced past midnight.
        let ring = await fetchRing(todayStr, token);
        let stale = false;
        if (ringIsEmpty(ring)) {
          const y = addDays(todayStr, -1);
          ring = (await env.KV_STORE.get(`ring_${y}`, { type: 'json' })) || (await fetchRing(y, token));
          stale = true;
        }
        const home = homeEnabled ? await fetchHome(todayStr, token) : null;

        // Pull any connected secondary sources too (best-effort; never block the display).
        const [sw, sf, sp, ss] = await Promise.all([
          safeGet(withings, env, todayStr),
          safeGet(fitbit, env, todayStr),
          safeGet(polar, env, todayStr),
          safeGet(samsung, env, todayStr),
        ]);

        history[todayStr] = ring.steps;
        ctx.waitUntil(env.KV_STORE.put('step_history', JSON.stringify(history)));
        ctx.waitUntil(env.KV_STORE.put(`ring_${todayStr}`, JSON.stringify(ring)));

        const yRing = (await env.KV_STORE.get(`ring_${addDays(todayStr, -1)}`, { type: 'json' })) || {};
        const hrvTrend = trend(ring.hrv, yRing.hrv).icon;
        const chart = weeklyChart(history, todayStr, stepGoal);
        const lastUpdated = new Intl.DateTimeFormat('en-GB', {
          hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz || 'UTC',
        }).format(now);

        const payload = buildDisplay({
          ring, home, chart, hrvTrend, lastUpdated, homeEnabled, stale,
          sources: { withings: sw, fitbit: sf, polar: sp, samsung: ss },
        });
        return json(payload, 200, { 'Cache-Control': 'public, max-age=900' });
      }

      return json({ error: 'not found', path }, 404);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};

// Gather one adapter's day, swallowing errors so one bad source can't break /json.
async function safeGet(adapter, env, date) {
  try {
    return await adapter.getDay(env, date);
  } catch (e) {
    console.error(`${adapter.id} getDay failed for ${date}: ${e.message}`);
    return null;
  }
}

// Build the unified model for an arbitrary date, preferring cached Ultrahuman data
// and pulling each connected secondary source in parallel.
async function getDayUnified(date, env, token, homeEnabled) {
  let ring = await env.KV_STORE.get(`ring_${date}`, { type: 'json' });
  if (!ring) {
    ring = await fetchRing(date, token);
    if (!ringIsEmpty(ring)) await env.KV_STORE.put(`ring_${date}`, JSON.stringify(ring));
  }

  let home = null;
  if (homeEnabled) {
    home = await env.KV_STORE.get(`home_${date}`, { type: 'json' });
    if (!home) {
      home = await fetchHome(date, token);
      await env.KV_STORE.put(`home_${date}`, JSON.stringify(home));
    }
  }

  const [w, f, p, s] = await Promise.all([
    safeGet(withings, env, date),
    safeGet(fitbit, env, date),
    safeGet(polar, env, date),
    safeGet(samsung, env, date),
  ]);

  const yRing = (await env.KV_STORE.get(`ring_${addDays(date, -1)}`, { type: 'json' })) || {};
  const r = ring || emptyRing();
  const trends = {
    hrv: trend(r.hrv, yRing.hrv).dir,
    rhr: trend(r.rhr, yRing.rhr).dir,
    steps: trend(r.steps, yRing.steps).dir,
  };
  return buildUnified({
    date, ring: r, home, withings: w, fitbit: f, polar: p, samsung: s, trends, stale: ringIsEmpty(r),
  });
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
