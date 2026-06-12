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

// The nightly-recharge endpoint returns hyphenated keys ("ans-charge",
// "heart-rate-avg"); sleep returns snake_case. Read both so either shape works.
const fld = (obj, name) => obj?.[name] ?? obj?.[name.replace(/-/g, '_')] ?? null;

// Pure: map Polar sleep + nightly-recharge (+ optional SleepWise alertness)
// responses to the normalized shape. Recharge field names verified against the
// AccessLink API (hyphenated); "heart-rate-variability-avg" is the true RMSSD —
// "beat-to-beat-avg" is the mean RR interval, kept in extra, not used as HRV.
export function normalize({ sleep, recharge, alertness = null }) {
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
        rhr: fld(recharge, 'heart-rate-avg'),
        hrv: fld(recharge, 'heart-rate-variability-avg'),
        breathing_rate: fld(recharge, 'breathing-rate-avg'),
      }
    : {};
  // Recovery/quality metrics beyond the canonical set. Numeric-only; the
  // exporter writes them as polar_<key> frontmatter and the dashboard plugin
  // discovers them as dynamic metrics.
  const extra = {};
  const put = (k, v) => {
    if (typeof v === 'number' && Number.isFinite(v)) extra[k] = v;
  };
  if (recharge) {
    put('nightly_recharge_status', fld(recharge, 'nightly-recharge-status')); // 1-6
    put('ans_charge', fld(recharge, 'ans-charge')); // -10..+10
    put('ans_charge_status', fld(recharge, 'ans-charge-status')); // 1-5
    put('beat_to_beat_avg', fld(recharge, 'beat-to-beat-avg')); // mean RR ms
  }
  if (sleep) {
    put('sleep_charge', sleep.sleep_charge); // 1-6
    put('sleep_continuity', sleep.continuity); // 0-10
    put('sleep_cycles', sleep.sleep_cycles);
    put('sleep_rating', sleep.sleep_rating);
    put('sleep_duration_score', sleep.group_duration_score);
    put('sleep_solidity_score', sleep.group_solidity_score);
    put('sleep_regeneration_score', sleep.group_regeneration_score);
  }
  if (alertness) put('alertness_grade', alertness.grade);
  return {
    connected: true,
    sleep: sleepObj,
    activity: null,
    vitals,
    extra,
  };
}

// Pick the SleepWise alertness record whose sleep ended on `date` (wake-up day,
// matching Polar's sleep-date convention) from the endpoint's recent-window list.
export function alertnessForDate(list, date) {
  if (!Array.isArray(list)) return null;
  return list.find((a) => typeof a?.sleep_period_end_time === 'string' && a.sleep_period_end_time.startsWith(date)) || null;
}

// The SleepWise endpoint returns a recent window with no date filter, so for
// historical backfill (older than this) a fetch can never match — skip it.
const ALERTNESS_MAX_AGE_DAYS = 14;

export async function getDay(env, date) {
  const t = await loadTokens(env, id);
  if (!t?.access_token) return null;
  const ageDays = (Date.now() - Date.parse(date)) / 86400000;
  const [sleep, recharge, alertnessList] = await Promise.all([
    get(t.access_token, `/v3/users/sleep/${date}`),
    get(t.access_token, `/v3/users/nightly-recharge/${date}`),
    ageDays <= ALERTNESS_MAX_AGE_DAYS
      ? get(t.access_token, '/v3/users/sleepwise/alertness').catch(() => null) // beta; best-effort
      : Promise.resolve(null),
  ]);
  const alertness = alertnessForDate(alertnessList, date);
  if (!sleep && !recharge && !alertness) {
    return { connected: true, sleep: null, activity: null, vitals: {}, extra: {} };
  }
  return normalize({ sleep, recharge, alertness });
}
