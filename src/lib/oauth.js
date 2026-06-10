// KV-backed OAuth token store + small helpers shared by the source adapters.
// Each adapter implements its own provider-specific exchange/refresh (Withings,
// Fitbit and Polar differ enough that one generic client would leak), but they
// all reuse this storage layer and the encoders below.

const tokKey = (source) => `oauth_${source}`;

export async function loadTokens(env, source) {
  return (await env.KV_STORE.get(tokKey(source), { type: 'json' })) || null;
}

export async function saveTokens(env, source, tokens) {
  await env.KV_STORE.put(tokKey(source), JSON.stringify(tokens));
}

export async function clearTokens(env, source) {
  await env.KV_STORE.delete(tokKey(source));
}

// Tokens without an expiry (e.g. Polar) are treated as non-expiring.
export function isExpired(tokens, skewSec = 90) {
  if (!tokens?.expires_at) return false;
  return Date.now() >= tokens.expires_at - skewSec * 1000;
}

export function expiresAt(expiresInSec) {
  return Date.now() + (Number(expiresInSec) || 0) * 1000;
}

export function formEncode(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

export function basicAuth(id, secret) {
  return 'Basic ' + btoa(`${id}:${secret}`);
}

export function randomState() {
  const r = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(r, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// `title` is escaped; `bodyHtml` is trusted markup built by the worker (never
// interpolate untrusted input into it — escape it at the call site if you must).
export function htmlPage(title, bodyHtml, status = 200) {
  const html =
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{font:16px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:34rem;padding:0 1rem}' +
    'code{background:#eee;padding:.1em .35em;border-radius:4px}h2{margin-bottom:.5rem}</style>' +
    `<h2>${escapeHtml(title)}</h2>${bodyHtml}`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// --- OAuth CSRF state: only an authorized /connect issues one; /callback consumes it ---
export async function saveState(env, state, source) {
  await env.KV_STORE.put(`oauthstate_${state}`, source, { expirationTtl: 600 });
}

export async function consumeState(env, state) {
  if (!state) return null;
  const key = `oauthstate_${state}`;
  const source = await env.KV_STORE.get(key);
  if (source) await env.KV_STORE.delete(key);
  return source; // null if missing or expired
}

// Shared access-token getter for refreshable providers (Withings, Fitbit).
// `refresh(refreshToken)` returns a fresh token record. A short KV lock serializes
// concurrent refreshes best-effort, reducing the rotating-refresh-token race.
export async function getAccessToken(env, source, refresh) {
  let t = await loadTokens(env, source);
  if (!t) return null;
  if (!isExpired(t)) return t.access_token;

  const lockKey = `oauthlock_${source}`;
  if (await env.KV_STORE.get(lockKey)) {
    await new Promise((r) => setTimeout(r, 800)); // let the other refresh land
    const fresh = await loadTokens(env, source);
    return fresh?.access_token ?? t.access_token;
  }
  await env.KV_STORE.put(lockKey, '1', { expirationTtl: 60 });
  try {
    t = await refresh(t.refresh_token);
    await saveTokens(env, source, t);
    return t.access_token;
  } finally {
    await env.KV_STORE.delete(lockKey);
  }
}
