// Fitbit source adapter. Standard OAuth2 (confidential client: Basic-auth token
// endpoint, rotating refresh tokens). Pulls sleep + activity + heart + hrv + spo2 + br.
import { saveTokens, expiresAt, formEncode, basicAuth, getAccessToken as sharedAccessToken } from '../lib/oauth.js';

export const id = 'fitbit';
const AUTH = 'https://www.fitbit.com/oauth2/authorize';
const TOKEN = 'https://api.fitbit.com/oauth2/token';
const API = 'https://api.fitbit.com';
const SCOPE = 'sleep activity heartrate oxygen_saturation respiratory_rate temperature';

export function configured(env) {
  return !!env.FITBIT_CLIENT_ID && !!env.FITBIT_CLIENT_SECRET;
}

export function authUrl(env, redirectUri, state) {
  return `${AUTH}?` + formEncode({
    response_type: 'code',
    client_id: env.FITBIT_CLIENT_ID,
    scope: SCOPE,
    redirect_uri: redirectUri,
    state,
    prompt: 'login consent',
  });
}

async function tokenRequest(env, params) {
  const resp = await fetch(TOKEN, {
    method: 'POST',
    headers: {
      Authorization: basicAuth(env.FITBIT_CLIENT_ID, env.FITBIT_CLIENT_SECRET),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: formEncode(params),
  });
  const j = await resp.json();
  if (!resp.ok) throw new Error(`Fitbit token error: ${j.errors?.[0]?.message || resp.status}`);
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: expiresAt(j.expires_in),
    user_id: j.user_id,
  };
}

export async function exchangeCode(env, code, redirectUri) {
  await saveTokens(env, id, await tokenRequest(env, {
    grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: env.FITBIT_CLIENT_ID,
  }));
}

export function getAccessToken(env) {
  return sharedAccessToken(env, id, (rt) =>
    tokenRequest(env, { grant_type: 'refresh_token', refresh_token: rt }));
}

async function get(token, path) {
  const r = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  return r.ok ? r.json() : null;
}

// Pure: combine the per-endpoint responses into the normalized shape.
export function normalize({ sleep, activity, heart, hrv, spo2, br }) {
  const sleeps = sleep?.sleep || [];
  const main = sleeps.find((s) => s.isMainSleep) || sleeps[0] || null;
  const stages = sleep?.summary?.stages || {};
  const sleepObj = main
    ? {
        score: null,
        duration_min: sleep?.summary?.totalMinutesAsleep ?? main.minutesAsleep ?? null,
        deep_min: stages.deep ?? null,
        rem_min: stages.rem ?? null,
        light_min: stages.light ?? null,
        awake_min: stages.wake ?? null,
        efficiency: main.efficiency ?? null,
      }
    : null;

  const sum = activity?.summary || {};
  const dist = Array.isArray(sum.distances)
    ? sum.distances.find((d) => d.activity === 'total')?.distance
    : null;
  const activityObj = activity
    ? {
        steps: sum.steps ?? null,
        active_min: (sum.veryActiveMinutes || 0) + (sum.fairlyActiveMinutes || 0),
        calories: sum.caloriesOut ?? null,
        distance_m: dist != null ? Math.round(dist * 1000) : null,
      }
    : null;

  const vitals = {
    rhr: heart?.['activities-heart']?.[0]?.value?.restingHeartRate ?? null,
    spo2: spo2?.value?.avg ?? null,
    hrv: hrv?.hrv?.[0]?.value?.dailyRmssd ?? null,
    breathing_rate: br?.br?.[0]?.value?.breathingRate ?? null,
  };

  return { connected: true, sleep: sleepObj, activity: activityObj, vitals, extra: {} };
}

export async function getDay(env, date) {
  const token = await getAccessToken(env);
  if (!token) return null;
  const [sleep, activity, heart, hrv, spo2, br] = await Promise.all([
    get(token, `/1.2/user/-/sleep/date/${date}.json`),
    get(token, `/1/user/-/activities/date/${date}.json`),
    get(token, `/1/user/-/activities/heart/date/${date}/1d.json`),
    get(token, `/1/user/-/hrv/date/${date}.json`),
    get(token, `/1/user/-/spo2/date/${date}.json`),
    get(token, `/1/user/-/br/date/${date}.json`),
  ]);
  return normalize({ sleep, activity, heart, hrv, spo2, br });
}
