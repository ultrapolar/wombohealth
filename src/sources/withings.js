// Withings (Sleep Analyzer etc.) source adapter.
// OAuth2 is non-standard: token requests need action=requesttoken and responses
// are wrapped in { status, body }. Sleep data via Sleep v2 getsummary.
import { loadTokens, saveTokens, isExpired, expiresAt, formEncode } from '../lib/oauth.js';

export const id = 'withings';
const AUTH = 'https://account.withings.com/oauth2_user/authorize2';
const TOKEN = 'https://wbsapi.withings.net/v2/oauth2';
const SLEEP = 'https://wbsapi.withings.net/v2/sleep';
const SCOPE = 'user.metrics,user.activity,user.sleepevents';
const FIELDS =
  'deepsleepduration,remsleepduration,lightsleepduration,wakeupduration,' +
  'durationtosleep,durationtowakeup,wakeupcount,hr_average,hr_min,hr_max,rr_average,snoring,sleep_score';

export function configured(env) {
  return !!env.WITHINGS_CLIENT_ID && !!env.WITHINGS_CLIENT_SECRET;
}

export function authUrl(env, redirectUri, state) {
  return `${AUTH}?` + formEncode({
    response_type: 'code',
    client_id: env.WITHINGS_CLIENT_ID,
    scope: SCOPE,
    redirect_uri: redirectUri,
    state,
  });
}

async function tokenRequest(env, params) {
  const resp = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formEncode({
      action: 'requesttoken',
      client_id: env.WITHINGS_CLIENT_ID,
      client_secret: env.WITHINGS_CLIENT_SECRET,
      ...params,
    }),
  });
  const j = await resp.json();
  if (j.status !== 0) throw new Error(`Withings token error ${j.status}: ${j.error || ''}`);
  const b = j.body;
  return {
    access_token: b.access_token,
    refresh_token: b.refresh_token,
    expires_at: expiresAt(b.expires_in),
    userid: b.userid,
  };
}

export async function exchangeCode(env, code, redirectUri) {
  await saveTokens(env, id, await tokenRequest(env, {
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
  }));
}

export async function getAccessToken(env) {
  let t = await loadTokens(env, id);
  if (!t) return null;
  if (isExpired(t)) {
    t = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: t.refresh_token });
    await saveTokens(env, id, t);
  }
  return t.access_token;
}

const sec2min = (s) => (s != null ? Math.round(s / 60) : null);

// Pure: map a Sleep v2 getsummary body to the normalized shape.
export function normalizeSleep(body) {
  const series = body?.series || [];
  if (!series.length) return null;
  const d = series[series.length - 1].data || {};
  const total = (d.deepsleepduration || 0) + (d.remsleepduration || 0) + (d.lightsleepduration || 0);
  return {
    score: d.sleep_score ?? null,
    duration_min: sec2min(total),
    deep_min: sec2min(d.deepsleepduration),
    rem_min: sec2min(d.remsleepduration),
    light_min: sec2min(d.lightsleepduration),
    awake_min: sec2min(d.wakeupduration),
    hr_avg: d.hr_average ?? null,
    hr_min: d.hr_min ?? null,
    rr_avg: d.rr_average ?? null,
    snoring_min: sec2min(d.snoring),
  };
}

export async function getDay(env, date) {
  const token = await getAccessToken(env);
  if (!token) return null;
  const resp = await fetch(SLEEP, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: formEncode({ action: 'getsummary', startdateymd: date, enddateymd: date, data_fields: FIELDS }),
  });
  const j = await resp.json();
  if (j.status !== 0) return { connected: true, error: `status ${j.status}`, sleep: null, activity: null, vitals: {}, extra: {} };
  const sleep = normalizeSleep(j.body);
  return {
    connected: true,
    sleep,
    activity: null,
    vitals: { rhr: sleep?.hr_min ?? null },
    extra: {},
  };
}
