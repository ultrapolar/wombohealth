// Tests for the shared OAuth layer: CSRF state lifecycle, expiry math, and the
// refresh path of getAccessToken (including the KV lock and its cleanup).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  loadTokens, saveTokens, clearTokens, isExpired, expiresAt, formEncode, basicAuth,
  randomState, escapeHtml, saveState, consumeState, getAccessToken,
} from '../src/lib/oauth.js';
import { FakeKV } from './helpers.mjs';

describe('CSRF state', () => {
  it('is single-use: consuming returns the source once, then null', async () => {
    const env = { KV_STORE: new FakeKV() };
    await saveState(env, 'abc123', 'fitbit');
    assert.equal(await consumeState(env, 'abc123'), 'fitbit');
    assert.equal(await consumeState(env, 'abc123'), null, 'replay must fail');
  });

  it('rejects missing or unknown state', async () => {
    const env = { KV_STORE: new FakeKV() };
    assert.equal(await consumeState(env, ''), null);
    assert.equal(await consumeState(env, undefined), null);
    assert.equal(await consumeState(env, 'never-issued'), null);
  });

  it('randomState is 48 hex chars and unique per call', () => {
    const a = randomState();
    const b = randomState();
    assert.match(a, /^[0-9a-f]{48}$/);
    assert.notEqual(a, b);
  });
});

describe('token expiry math', () => {
  it('tokens without an expiry never expire (Polar)', () => {
    assert.equal(isExpired(null), false);
    assert.equal(isExpired({}), false);
    assert.equal(isExpired({ access_token: 'x' }), false);
  });

  it('honors the refresh skew window', () => {
    const in10min = Date.now() + 10 * 60 * 1000;
    const in30sec = Date.now() + 30 * 1000;
    assert.equal(isExpired({ expires_at: in10min }), false);
    assert.equal(isExpired({ expires_at: in30sec }), true, 'inside the 90s skew counts as expired');
    assert.equal(isExpired({ expires_at: Date.now() - 1000 }), true);
    assert.equal(isExpired({ expires_at: in30sec, }, 0), false, 'skew 0 trusts the clock');
  });

  it('expiresAt converts seconds-from-now and tolerates junk', () => {
    const before = Date.now();
    const at = expiresAt(3600);
    assert.ok(at >= before + 3600 * 1000 && at <= Date.now() + 3600 * 1000 + 50);
    assert.ok(expiresAt('nope') <= Date.now(), 'non-numeric expiry -> already expired, not NaN');
    assert.ok(Number.isFinite(expiresAt(undefined)));
  });
});

describe('token store', () => {
  it('round-trips and clears tokens', async () => {
    const env = { KV_STORE: new FakeKV() };
    assert.equal(await loadTokens(env, 'fitbit'), null);
    await saveTokens(env, 'fitbit', { access_token: 'a', refresh_token: 'r' });
    assert.deepEqual(await loadTokens(env, 'fitbit'), { access_token: 'a', refresh_token: 'r' });
    await clearTokens(env, 'fitbit');
    assert.equal(await loadTokens(env, 'fitbit'), null);
  });
});

describe('getAccessToken', () => {
  const tokens = (expiresInMs, n = 1) => ({
    access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_at: Date.now() + expiresInMs,
  });

  it('returns null when the source was never connected', async () => {
    const env = { KV_STORE: new FakeKV() };
    let called = false;
    assert.equal(await getAccessToken(env, 'fitbit', () => { called = true; }), null);
    assert.equal(called, false, 'no refresh attempted without tokens');
  });

  it('returns the current token without refreshing when unexpired', async () => {
    const env = { KV_STORE: new FakeKV() };
    await saveTokens(env, 'fitbit', tokens(60 * 60 * 1000));
    let called = false;
    assert.equal(await getAccessToken(env, 'fitbit', () => { called = true; }), 'at-1');
    assert.equal(called, false);
  });

  it('refreshes an expired token, saves it, and releases the lock', async () => {
    const env = { KV_STORE: new FakeKV() };
    await saveTokens(env, 'fitbit', tokens(-1000, 1));
    const refresh = async (rt) => {
      assert.equal(rt, 'rt-1', 'refresh gets the stored refresh token');
      return tokens(60 * 60 * 1000, 2);
    };
    assert.equal(await getAccessToken(env, 'fitbit', refresh), 'at-2');
    assert.equal((await loadTokens(env, 'fitbit')).refresh_token, 'rt-2', 'rotated tokens persisted');
    assert.equal(await env.KV_STORE.get('oauthlock_fitbit'), null, 'lock released');
  });

  it('releases the lock even when the refresh throws', async () => {
    const env = { KV_STORE: new FakeKV() };
    await saveTokens(env, 'fitbit', tokens(-1000));
    await assert.rejects(
      () => getAccessToken(env, 'fitbit', async () => { throw new Error('provider down'); }),
      /provider down/,
    );
    assert.equal(await env.KV_STORE.get('oauthlock_fitbit'), null, 'lock must not stay stuck');
  });

  it('waits out a concurrent refresh instead of racing it', async () => {
    const env = { KV_STORE: new FakeKV() };
    await saveTokens(env, 'fitbit', tokens(-1000, 1));
    await env.KV_STORE.put('oauthlock_fitbit', '1');
    let called = false;
    const pending = getAccessToken(env, 'fitbit', () => { called = true; });
    // Simulate the lock holder landing its refreshed tokens during the wait.
    await new Promise((r) => setTimeout(r, 100));
    await saveTokens(env, 'fitbit', tokens(60 * 60 * 1000, 2));
    assert.equal(await pending, 'at-2', 'returns the other refresh\'s token');
    assert.equal(called, false, 'must not start a second refresh');
  });
});

describe('encoders', () => {
  it('formEncode URL-encodes and skips null/undefined values', () => {
    assert.equal(
      formEncode({ a: 'x y', b: 'c&d', skip: null, gone: undefined, n: 0 }),
      'a=x%20y&b=c%26d&n=0',
    );
  });

  it('basicAuth produces the expected header value', () => {
    assert.equal(basicAuth('id', 'secret'), 'Basic ' + Buffer.from('id:secret').toString('base64'));
  });

  it('escapeHtml neutralizes markup metacharacters', () => {
    assert.equal(
      escapeHtml(`<img src=x onerror="alert('1')">&`),
      '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;',
    );
  });
});
