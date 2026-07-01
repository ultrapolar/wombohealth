// Route-level tests for the Worker's HTTP surface: key auth, PUBLIC_DISPLAY
// gating, input validation on /json and the ingest routes, OAuth connect/callback
// state handling, and the error handler. Run: node --test test/
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { FakeKV, makeCtx, makeEnv, freshWorker, stubFetch } from './helpers.mjs';

const KEY = 'test-export-key';
const DATE = '2026-06-01';

const seededRing = () => ({
  steps: 5000, hrv: 40, rhr: 55, vo2Max: 48, recovery: 70, movementIndex: 6, activeMin: 30,
  sleepScore: 82, cycles: 4, alertness: 80,
  sleepSec: 27000, remSec: 5400, deepSec: 3600, lightSec: 18000, timeInBedSec: 28800,
  spo2: 97, tempC: 36.5,
});

let fetchStub;
beforeEach(() => { fetchStub = stubFetch(); });
afterEach(() => { fetchStub.restore(); });

async function call(worker, path, env, { method = 'GET', body, headers } = {}) {
  const ctx = makeCtx();
  const res = await worker.fetch(new Request(`https://worker.test${path}`, { method, body, headers }), env, ctx);
  await ctx.flush();
  return res;
}

describe('key auth', () => {
  it('rejects gated routes without a key', async () => {
    const worker = await freshWorker();
    const env = makeEnv();
    for (const path of ['/status', '/json', '/debug/raw', '/connect/withings']) {
      const res = await call(worker, path, env);
      assert.equal(res.status, 401, `${path} without key`);
      assert.deepEqual(await res.json(), { error: 'unauthorized' });
    }
  });

  it('rejects a wrong key of the same length and of a different length', async () => {
    const worker = await freshWorker();
    const env = makeEnv();
    const wrongSameLen = 'X'.repeat(KEY.length);
    assert.equal((await call(worker, `/status?key=${wrongSameLen}`, env)).status, 401);
    assert.equal((await call(worker, '/status?key=short', env)).status, 401);
  });

  it('accepts the key via query param and via x-export-key header', async () => {
    const worker = await freshWorker();
    const env = makeEnv();
    const viaQuery = await call(worker, `/status?key=${KEY}`, env);
    assert.equal(viaQuery.status, 200);
    const body = await viaQuery.json();
    assert.equal(body.ultrahuman.connected, true);

    const viaHeader = await call(worker, '/status', env, { headers: { 'x-export-key': KEY } });
    assert.equal(viaHeader.status, 200);
  });

  it('denies everything when EXPORT_KEY is not configured (fails closed)', async () => {
    const worker = await freshWorker();
    const env = makeEnv({ EXPORT_KEY: undefined });
    assert.equal((await call(worker, '/status', env)).status, 401);
    assert.equal((await call(worker, '/status?key=', env)).status, 401);
    assert.equal((await call(worker, `/status?key=${KEY}`, env)).status, 401);
  });

  it('POST ingest routes are key-gated too', async () => {
    const worker = await freshWorker();
    const env = makeEnv();
    for (const path of ['/ingest/samsung', '/ingest/wyze']) {
      const res = await call(worker, path, env, { method: 'POST', body: '{}' });
      assert.equal(res.status, 401, `${path} without key`);
    }
  });
});

describe('GET / display gating', () => {
  const cachedPayload = { steps: 1234, meta: { stale: false } };
  const freshCache = () => JSON.stringify({ ts: Date.now(), payload: cachedPayload });

  it('is 401 without a key when PUBLIC_DISPLAY is not "true"', async () => {
    const worker = await freshWorker();
    for (const publicDisplay of [undefined, 'false', 'TRUE', '1']) {
      const env = makeEnv({ PUBLIC_DISPLAY: publicDisplay });
      const res = await call(worker, '/', env);
      assert.equal(res.status, 401, `PUBLIC_DISPLAY=${publicDisplay}`);
    }
  });

  it('serves the cached payload without a key when PUBLIC_DISPLAY=true', async () => {
    const worker = await freshWorker();
    const env = makeEnv({
      PUBLIC_DISPLAY: 'true',
      KV_STORE: new FakeKV({ display_cache: freshCache() }),
    });
    const res = await call(worker, '/', env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), cachedPayload);
    assert.equal(fetchStub.calls.length, 0, 'fresh cache must not hit upstream');
  });

  it('serves a keyed request when PUBLIC_DISPLAY is off', async () => {
    const worker = await freshWorker();
    const env = makeEnv({ KV_STORE: new FakeKV({ display_cache: freshCache() }) });
    const res = await call(worker, `/?key=${KEY}`, env);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), cachedPayload);
  });

  it('rebuilds an expired cache and flags an empty ring day as stale', async () => {
    const worker = await freshWorker();
    const expired = JSON.stringify({ ts: Date.now() - 10 * 60 * 1000, payload: cachedPayload });
    const env = makeEnv({ KV_STORE: new FakeKV({ display_cache: expired }) });
    const res = await call(worker, `/?key=${KEY}`, env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.meta.stale, true, 'empty upstream ring -> stale payload');
    assert.ok(fetchStub.calls.length > 0, 'expired cache must refetch upstream');
    const stored = await env.KV_STORE.get('display_cache', { type: 'json' });
    assert.equal(stored.payload.meta.stale, true, 'rebuilt payload written back to KV');
  });
});

describe('GET /json', () => {
  it('rejects malformed and impossible dates', async () => {
    const worker = await freshWorker();
    const env = makeEnv();
    for (const bad of ['2026-13-40', '2026-6-1', 'yesterday', '2026-06-01%20OR%201=1']) {
      const res = await call(worker, `/json?key=${KEY}&date=${bad}`, env);
      assert.equal(res.status, 400, `date=${bad}`);
      assert.deepEqual(await res.json(), { error: 'invalid date (YYYY-MM-DD)' });
    }
  });

  it('returns the unified model for a cached day with no-store caching', async () => {
    const worker = await freshWorker();
    const env = makeEnv({
      KV_STORE: new FakeKV({ [`ring_${DATE}`]: JSON.stringify(seededRing()) }),
    });
    const res = await call(worker, `/json?key=${KEY}&date=${DATE}`, env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.equal(body.date, DATE);
    assert.equal(body.stale, false);
    assert.equal(body.ultrahuman.sleep.score, 82);
    assert.equal(body.ultrahuman.sleep.duration_min, 450);
    assert.equal(body.ultrahuman.activity.steps, 5000);
    assert.equal(body.withings, null, 'unconnected source stays null');
    assert.equal(body.samsung, null);
    assert.equal(body.trends.hrv, 'flat', 'no yesterday data -> flat trend');
  });
});

describe('ingest routes', () => {
  it('rejects bodies over the size limit with 413', async () => {
    const worker = await freshWorker();
    const env = makeEnv();
    const res = await call(worker, `/ingest/samsung?key=${KEY}`, env, {
      method: 'POST', body: '{}', headers: { 'content-length': String(64 * 1024) },
    });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'body too large' });
  });

  it('rejects non-JSON and non-object bodies with 400', async () => {
    const worker = await freshWorker();
    const env = makeEnv();
    for (const body of ['not json', '"a string"', '42', 'null']) {
      const res = await call(worker, `/ingest/samsung?key=${KEY}`, env, { method: 'POST', body });
      assert.equal(res.status, 400, `body=${body}`);
      assert.deepEqual(await res.json(), { error: 'invalid JSON body' });
    }
  });

  it('rejects an invalid date on ingest', async () => {
    const worker = await freshWorker();
    const env = makeEnv();
    const res = await call(worker, `/ingest/wyze?key=${KEY}&date=2026-99-99`, env, {
      method: 'POST', body: '{}',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid date (YYYY-MM-DD)' });
  });

  it('samsung ingest sanitizes, stores, and is visible via /json on the same instance', async () => {
    const worker = await freshWorker();
    const env = makeEnv();
    const payload = {
      date: DATE,
      sleep: { score: 80, duration_min: '430', injected: '<script>' },
      activity: { steps: 9000 },
      vitals: { rhr: 55 },
      evil_group: { x: 1 },
    };
    const res = await call(worker, `/ingest/samsung?key=${KEY}`, env, {
      method: 'POST', body: JSON.stringify(payload),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, date: DATE });

    const stored = await env.KV_STORE.get(`samsung_${DATE}`, { type: 'json' });
    assert.deepEqual(stored, {
      sleep: { score: 80, duration_min: 430 },
      activity: { steps: 9000 },
      vitals: { rhr: 55 },
    }, 'only allowlisted numeric fields are stored');

    const day = await (await call(worker, `/json?key=${KEY}&date=${DATE}`, env)).json();
    assert.equal(day.samsung.connected, true);
    assert.equal(day.samsung.sleep.score, 80);
    assert.equal(day.samsung.sleep.injected, undefined);
  });

  it('wyze ingest stores the weigh-in and updates wyze_latest', async () => {
    const worker = await freshWorker();
    const env = makeEnv();
    const res = await call(worker, `/ingest/wyze?key=${KEY}&date=${DATE}`, env, {
      method: 'POST',
      body: JSON.stringify({ measured_at: 1780300800, body: { weight_kg: 78.2, evil: 'x' } }),
    });
    assert.equal(res.status, 200);
    const latest = await env.KV_STORE.get('wyze_latest', { type: 'json' });
    assert.equal(latest.date, DATE);
    assert.equal(latest.body.weight_kg, 78.2);
    assert.equal('evil' in latest.body, false);

    const day = await (await call(worker, `/json?key=${KEY}&date=${DATE}`, env)).json();
    assert.equal(day.wyze.connected, true);
    assert.equal(day.wyze.carried_forward, false);
    assert.equal(day.wyze.body.weight_kg, 78.2);
  });
});

describe('OAuth connect/callback routes', () => {
  const withingsEnv = () => makeEnv({
    WITHINGS_CLIENT_ID: 'cid',
    WITHINGS_CLIENT_SECRET: 'csecret',
  });

  it('404s for an unknown source', async () => {
    const worker = await freshWorker();
    const env = makeEnv();
    assert.equal((await call(worker, `/connect/nope?key=${KEY}`, env)).status, 404);
    assert.equal((await call(worker, '/callback/nope', env)).status, 404);
  });

  it('explains missing client credentials instead of redirecting', async () => {
    const worker = await freshWorker();
    const res = await call(worker, `/connect/withings?key=${KEY}`, makeEnv());
    assert.equal(res.status, 400);
    assert.match(await res.text(), /WITHINGS_CLIENT_ID/);
  });

  it('redirects to the provider and stores a one-time state', async () => {
    const worker = await freshWorker();
    const env = withingsEnv();
    const res = await call(worker, `/connect/withings?key=${KEY}`, env);
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get('location'));
    assert.equal(loc.origin, 'https://account.withings.com');
    assert.equal(loc.searchParams.get('client_id'), 'cid');
    assert.equal(loc.searchParams.get('redirect_uri'), 'https://worker.test/callback/withings');
    const state = loc.searchParams.get('state');
    assert.match(state, /^[0-9a-f]{48}$/);
    assert.equal(await env.KV_STORE.get(`oauthstate_${state}`), 'withings');
  });

  it('rejects a callback with a missing code or a bad state', async () => {
    const worker = await freshWorker();
    const env = withingsEnv();
    const noCode = await call(worker, '/callback/withings?state=abc', env);
    assert.equal(noCode.status, 400);
    assert.match(await noCode.text(), /Missing code/);

    const badState = await call(worker, '/callback/withings?code=c123&state=forged', env);
    assert.equal(badState.status, 400);
    assert.match(await badState.text(), /Missing or expired state/);
  });

  it('rejects a state issued for a different source', async () => {
    const worker = await freshWorker();
    const env = withingsEnv();
    await env.KV_STORE.put('oauthstate_xyz', 'fitbit');
    const res = await call(worker, '/callback/withings?code=c123&state=xyz', env);
    assert.equal(res.status, 400);
  });

  it('surfaces a provider denial without consuming anything', async () => {
    const worker = await freshWorker();
    const res = await call(worker, '/callback/withings?error=access_denied', withingsEnv());
    assert.equal(res.status, 400);
    assert.match(await res.text(), /denied/);
  });

  it('exchanges the code and stores tokens on a valid callback', async () => {
    fetchStub.restore();
    fetchStub = stubFetch(async (url) => {
      if (url === 'https://wbsapi.withings.net/v2/oauth2') {
        return Response.json({
          status: 0,
          body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, userid: 7 },
        });
      }
      return null;
    });
    const worker = await freshWorker();
    const env = withingsEnv();
    await env.KV_STORE.put('oauthstate_goodstate', 'withings');

    const res = await call(worker, '/callback/withings?code=c123&state=goodstate', env);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Connected/);
    const tokens = await env.KV_STORE.get('oauth_withings', { type: 'json' });
    assert.equal(tokens.access_token, 'at-1');
    assert.equal(tokens.refresh_token, 'rt-1');
    assert.equal(await env.KV_STORE.get('oauthstate_goodstate'), null, 'state is single-use');
  });
});

describe('error handling and fallbacks', () => {
  it('404s unknown paths', async () => {
    const worker = await freshWorker();
    const res = await call(worker, `/nope?key=${KEY}`, makeEnv());
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'not found' });
  });

  it('returns an opaque 500 when bindings are missing', async () => {
    const worker = await freshWorker();
    for (const env of [makeEnv({ KV_STORE: undefined }), makeEnv({ API_TOKEN: undefined })]) {
      const res = await call(worker, `/status?key=${KEY}`, env);
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: 'internal error' }, 'no internals leaked');
    }
  });

  it('returns an opaque 500 when KV itself throws', async () => {
    const worker = await freshWorker();
    const env = makeEnv();
    env.KV_STORE.get = async () => { throw new Error('kv exploded: secret detail'); };
    const res = await call(worker, `/status?key=${KEY}`, env);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: 'internal error' });
  });
});
