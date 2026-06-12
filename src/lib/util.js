// Pure helpers shared across the worker. No Workers-runtime APIs are used here,
// so this module imports cleanly under plain Node for unit testing.

// Reduce an untrusted name to a strict [a-z0-9_] slug (must start with a letter).
// This is the security boundary that keeps pushed names from injecting YAML or
// markup into vault frontmatter keys downstream — every source that emits
// dynamic key names (habits, Ultrahuman extras) must go through it.
export function slugKey(name, maxLen = 40) {
  const s = String(name).trim().toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, maxLen);
  return /^[a-z]/.test(s) ? s : '';
}

// Coerce an untrusted value to a finite number, or undefined. Shared by all
// ingest sanitizers so identical payloads behave the same on every endpoint.
export function coerceNum(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  return Number.isFinite(n) ? n : undefined;
}

export function getDurationInSeconds(moduleObj, key) {
  if (!moduleObj || !moduleObj[key]) return 0;
  if (moduleObj[key].seconds) return moduleObj[key].seconds;
  if (moduleObj[key].minutes) return moduleObj[key].minutes * 60;
  return 0;
}

export function getValue(obj, preferredKey = 'value') {
  if (obj === null || obj === undefined) return 0;
  if (typeof obj === 'object') {
    return obj[preferredKey] ?? obj.value ?? obj.avg ?? obj.total ?? 0;
  }
  return obj;
}

export function getAverage(obj, ignoreZeros = false) {
  if (!obj) return 0;
  if (obj.avg) return obj.avg;
  if (obj.value) return obj.value;
  if (Array.isArray(obj.values)) {
    let valid = obj.values;
    if (ignoreZeros) valid = valid.filter((v) => v.value > 0);
    if (valid.length === 0) return 0;
    const sum = valid.reduce((a, b) => a + b.value, 0);
    return sum / valid.length;
  }
  return 0;
}

export function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}

// Trend comparing today vs yesterday (numeric). Returns an arrow + direction word.
export function trend(today, yesterday) {
  const t = Number(today);
  const y = Number(yesterday);
  if (!y || !t) return { icon: '−', dir: 'flat' };
  if (t > y) return { icon: '▲', dir: 'up' };
  if (t < y) return { icon: '▼', dir: 'down' };
  return { icon: '−', dir: 'flat' };
}

// YYYY-MM-DD for `date` in an IANA timezone (DST-aware). Falls back to a fixed
// hour offset when no timezone is given.
export function localDateStr(date, timezone, offsetHours) {
  if (timezone) {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  }
  const shifted = new Date(date.getTime() + (offsetHours || 0) * 3600 * 1000);
  return shifted.toISOString().split('T')[0];
}

// Add `delta` days to a YYYY-MM-DD string, returning a YYYY-MM-DD string.
export function addDays(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().split('T')[0];
}

// Strict YYYY-MM-DD validation (also rejects impossible dates like 2026-13-40).
// Used to gate any caller-supplied date before it touches KV keys or upstream URLs.
export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Constant-time string equality — avoids leaking the secret via response timing.
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 7 bars (Mon..Sun) for the week containing `todayStr`, each = % of step goal (cap 100).
export function weeklyChart(history, todayStr, stepGoal = 10000) {
  const today = new Date(todayStr + 'T00:00:00Z');
  const dow = today.getUTCDay();
  const diffToMon = (dow === 0 ? -6 : 1) - dow;
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() + diffToMon);
  const bars = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    const dStr = d.toISOString().split('T')[0];
    const p = Math.round(((history[dStr] || 0) / stepGoal) * 100);
    bars.push(Math.min(p, 100));
  }
  return bars;
}
