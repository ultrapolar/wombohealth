// The ingest sanitizers are the injection barrier between pushed payloads and
// the Obsidian vault / TRMNL display: only allowlisted numeric fields may pass.
// Also covers Wyze's carry-forward staleness window.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as samsung from '../src/sources/samsung.js';
import * as wyze from '../src/sources/wyze.js';
import { FakeKV } from './helpers.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('samsung.sanitize', () => {
  it('keeps only allowlisted numeric fields per group', () => {
    const out = samsung.sanitize({
      sleep: { score: 80, duration_min: 430, note: 'hi', evil: '<script>alert(1)</script>' },
      activity: { steps: 9000, calories: 2300, gps_trace: [1, 2, 3] },
      vitals: { rhr: 55, spo2: 97, ssn: '123-45-6789' },
    });
    assert.deepEqual(out, {
      sleep: { score: 80, duration_min: 430 },
      activity: { steps: 9000, calories: 2300 },
      vitals: { rhr: 55, spo2: 97 },
    });
  });

  it('coerces numeric strings and drops everything non-finite', () => {
    const out = samsung.sanitize({
      sleep: { score: '80', duration_min: '430.5' },
      vitals: { rhr: 'NaN', spo2: 'ninety', hrv: Infinity, breathing_rate: '' },
    });
    assert.deepEqual(out, { sleep: { score: 80, duration_min: 430.5 } });
  });

  it('ignores unknown groups and non-object groups', () => {
    assert.deepEqual(samsung.sanitize({ malware: { steps: 1 }, sleep: 'yes', activity: 42 }), {});
    assert.deepEqual(samsung.sanitize(null), {});
    assert.deepEqual(samsung.sanitize('a string'), {});
  });

  it('normalize marks stored data connected and passes groups through', () => {
    const n = samsung.normalize({ sleep: { score: 77 } });
    assert.equal(n.connected, true);
    assert.equal(n.sleep.score, 77);
    assert.equal(n.activity, null);
    assert.equal(samsung.normalize(null), null);
  });
});

describe('wyze.sanitize', () => {
  it('keeps only allowlisted numeric body fields', () => {
    const out = wyze.sanitize({
      measured_at: 1780300800,
      body: { weight_kg: 78.2, bmr_kcal: '1680', evil: '<x>', nested: { a: 1 } },
    });
    assert.deepEqual(out, { body: { weight_kg: 78.2, bmr_kcal: 1680 }, measured_at: 1780300800 });
  });

  it('accepts a flat payload without a body wrapper', () => {
    const out = wyze.sanitize({ weight_kg: 80, body_fat_pct: '19.1' });
    assert.deepEqual(out.body, { weight_kg: 80, body_fat_pct: 19.1 });
    assert.equal(out.measured_at, null);
  });

  it('drops non-numeric measured_at and handles junk payloads', () => {
    assert.equal(wyze.sanitize({ measured_at: 'yesterday', body: { weight_kg: 1 } }).measured_at, null);
    assert.deepEqual(wyze.sanitize(null), { body: {}, measured_at: null });
  });

  it('ingest is a no-op when nothing usable survives sanitizing', async () => {
    const kv = new FakeKV();
    await wyze.ingest({ KV_STORE: kv }, '2026-06-01', { body: { evil: 'x' } });
    assert.equal(kv.map.size, 0, 'no KV writes for an empty weigh-in');
  });
});

describe('wyze.getDay carry-forward', () => {
  const record = (date, measuredAtSec) =>
    JSON.stringify({ date, measured_at: measuredAtSec, body: { weight_kg: 78 } });
  const nowSec = Math.floor(Date.now() / 1000);

  it('returns the exact day when present, not carried forward', async () => {
    const env = { KV_STORE: new FakeKV({ 'wyze_2026-06-01': record('2026-06-01', nowSec) }) };
    const day = await wyze.getDay(env, '2026-06-01');
    assert.equal(day.carried_forward, false);
    assert.equal(day.measured_date, '2026-06-01');
  });

  it('carries a recent weigh-in forward, flagged and dated', async () => {
    const fiveDaysAgo = nowSec - 5 * DAY_MS / 1000;
    const env = { KV_STORE: new FakeKV({ wyze_latest: record('2026-05-27', fiveDaysAgo) }) };
    const day = await wyze.getDay(env, '2026-06-01');
    assert.equal(day.carried_forward, true);
    assert.equal(day.measured_date, '2026-05-27');
    assert.equal(day.body.weight_kg, 78);
  });

  it('refuses to carry a weigh-in past the 21-day window', async () => {
    const thirtyDaysAgo = nowSec - 30 * DAY_MS / 1000;
    const env = { KV_STORE: new FakeKV({ wyze_latest: record('2026-05-02', thirtyDaysAgo) }) };
    assert.equal(await wyze.getDay(env, '2026-06-01'), null);
  });

  it('handles measured_at stored in milliseconds too', async () => {
    const env = { KV_STORE: new FakeKV({ wyze_latest: record('2026-05-27', Date.now() - 5 * DAY_MS) }) };
    const day = await wyze.getDay(env, '2026-06-01');
    assert.equal(day.carried_forward, true);
  });

  it('returns null when nothing was ever ingested', async () => {
    assert.equal(await wyze.getDay({ KV_STORE: new FakeKV() }, '2026-06-01'), null);
  });
});
