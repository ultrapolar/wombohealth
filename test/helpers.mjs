// Shared test doubles for the node:test suites. No Workers runtime needed:
// the router is exercised by calling the worker's fetch() with a fake env/ctx.

// In-memory stand-in for a Workers KV namespace.
export class FakeKV {
  constructor(seed = {}) {
    this.map = new Map(Object.entries(seed));
  }
  async get(key, options = {}) {
    if (!this.map.has(key)) return null;
    const val = this.map.get(key);
    const type = typeof options === 'string' ? options : options.type;
    return type === 'json' ? JSON.parse(val) : val;
  }
  async put(key, value) {
    this.map.set(key, String(value));
  }
  async delete(key) {
    this.map.delete(key);
  }
}

// ExecutionContext stub that records waitUntil promises so tests can settle
// background work (including work queued by that work) before asserting.
export function makeCtx() {
  const pending = [];
  return {
    waitUntil(p) {
      pending.push(Promise.resolve(p).catch(() => {}));
    },
    async flush() {
      while (pending.length) await Promise.all(pending.splice(0));
    },
  };
}

export function makeEnv(overrides = {}) {
  return {
    KV_STORE: new FakeKV(),
    API_TOKEN: 'uh-token',
    EXPORT_KEY: 'test-export-key',
    ...overrides,
  };
}

// Import a fresh copy of the worker module. index.js keeps a module-global
// memCache, so tests that must not see each other's cache entries need their
// own module instance; a unique query string forces a separate ESM instance.
let importCounter = 0;
export async function freshWorker() {
  const mod = await import(`../src/index.js?test=${importCounter++}`);
  return mod.default;
}

// Replace global fetch with a stub so no test ever hits the network.
// Returns { calls, restore }. The handler gets (url, init) and may return a
// Response; by default everything 404s (upstream adapters treat that as "no data").
export function stubFetch(handler = null) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const custom = handler && (await handler(String(url), init));
    return custom || new Response('not found', { status: 404 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
