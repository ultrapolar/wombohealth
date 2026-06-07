// Polar (Flow / AccessLink) source adapter.
// OAuth2 with Basic-auth token endpoint; tokens are long-lived (no refresh token).
// After token exchange the user must be REGISTERED with AccessLink (idempotent).
// We pull non-transactional, re-fetchable data only: Sleep + Nightly Recharge by
// date. (Daily activity/steps is transactional — data is deleted once committed,
// which breaks idempotent backfill, and steps already come from Ultrahuman — so
// it's intentionally omitted here.)
import { loadTokens, saveTokens, formEncode, basicAuth } from '../lib/oauth.js';

export const id = 'polar';
const AUTH = 'https://flow.polar.com/oauth2/authorization';
const TOKEN = 'https://polarremote.com/v2/oauth2/token';
const API = 'https://www.polaraccesslink.com';
const SCOPE = 'accesslink.read_all';

export function configured(env) {
  return !!env.POLAR_CLIENT_ID && !!env.POLAR_CLIENT_SECRET;
}

export function authUrl(env, redirectUri, state) {
  return `${AUTH}?` + formEncode({
    response_type: 'code',
    client_id: env.POLAR_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
  });
}

export async function exchangeCode(env, code, redirectUri) {
  const resp = await fetch(TOKEN, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(env.POLAR_CLIENT_ID, env.POLAR_CLIENT_SECRET),
      'content-type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: formEncode({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
  });
  const j = await resp.json();
  if (!resp.ok) throw new Error(`Polar token error: ${j.error || resp.status}`);
  await saveTokens(env, id, { access_token: j.access_token, x_user_id: j.x_user_id, expires_at: null });

  // Register the user with AccessLink (required once; 409 = already registered).
  try {
    await fetch(`${API}/v3/users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${j.access_token}`,
        'content-type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ 'member-id': `trmnl-health-${j.x_user_id}` }),
    });
  } catch {
    /* ignore — registration is best-effort/idempotent */
  }
}

async function get(token, path) {
  const r = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (r.status === 204 || !r.ok) return null;
  return r.json();
}

const sec2min = (s) => (s != null ? Math.round(s / 60) : null);

// Pure: map Polar sleep + nightly-recharge responses to the normalized shape.
// Field names are PROVISIONAL — confirm against real data and adjust if needed.
export function normalize({ sleep, recharge }) {
  const sleepObj = sleep
    ? {
        score: sleep.sleep_score ?? null,
        duration_min: sec2min((sleep.light_sleep || 0) + (sleep.deep_sleep || 0) + (sleep.rem_sleep || 0)),
        deep_min: sec2min(sleep.deep_sleep),
        rem_min: sec2min(sleep.rem_sleep),
        light_min: sec2min(sleep.light_sleep),
        awake_min: sec2min(sleep.total_interruption_duration),
      }
    : null;
  const vitals = recharge
    ? {
        rhr: recharge.heart_rate_avg ?? null,
        hrv: recharge.beat_to_beat_avg ?? recharge.hrv_avg ?? null,
        breathing_rate: recharge.breathing_rate_avg ?? null,
      }
    : {};
  return {
    connected: true,
    sleep: sleepObj,
    activity: null,
    vitals,
    extra: { nightly_recharge_status: recharge?.nightly_recharge_status ?? null },
  };
}

export async function getDay(env, date) {
  const t = await loadTokens(env, id);
  if (!t?.access_token) return null;
  const [sleep, recharge] = await Promise.all([
    get(t.access_token, `/v3/users/sleep/${date}`),
    get(t.access_token, `/v3/users/nightly-recharge/${date}`),
  ]);
  if (!sleep && !recharge) return { connected: true, sleep: null, activity: null, vitals: {}, extra: {} };
  return normalize({ sleep, recharge });
}
