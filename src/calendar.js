// Proton Calendar (or any ICS feed) -> compact agenda JSON.
//
// Proton Calendar is end-to-end encrypted and has no public API, but
// Settings -> Share calendar -> "Share with anyone via link" yields a
// read-only ICS feed. We fetch that (PROTON_ICS_URL secret; comma-separate
// several links), parse VEVENTs, expand basic recurrence, and serve a small
// sorted window for the Pebble agenda + timeline pins. Works just as well
// with any other ICS URL (iCloud public links, Fastmail, etc.).

const MAX_EVENTS = 50;
const MAX_ITERATIONS = 1000;
const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// RFC 5545 line unfolding: CRLF followed by space/tab continues the line.
export function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function unescapeText(s) {
  return String(s)
    .replace(/\\n/gi, ' ')
    .replace(/\\([,;\\])/g, '$1')
    .trim();
}

// "20260613T140000Z" | "20260613T140000" | "20260613" -> parts
function parseDate(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  return {
    y: +m[1], mo: +m[2], d: +m[3],
    h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0),
    utc: !!m[7],
    dateOnly: !m[4],
  };
}

// Offset of `tz` from UTC at a given instant (ms).
function tzOffsetMs(tz, atMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(atMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - atMs;
}

// Epoch ms for wall-clock time in `tz` (DST-aware, refined once for edges).
export function epochFromLocal(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  if (!tz) return guess;
  let e = guess - tzOffsetMs(tz, guess);
  const off2 = tzOffsetMs(tz, e);
  return guess - off2;
}

function toEpochMs(dt, tz) {
  if (!dt) return null;
  if (dt.utc) return Date.UTC(dt.y, dt.mo - 1, dt.d, dt.h, dt.mi, dt.s);
  // Floating / TZID times: treat as the user's configured timezone. Personal
  // calendars are nearly always authored in the user's own zone.
  return epochFromLocal(dt.y, dt.mo, dt.d, dt.h, dt.mi, dt.s, tz);
}

function parseRRule(value) {
  const out = {};
  for (const part of value.split(';')) {
    const [k, v] = part.split('=');
    if (!k || v === undefined) continue;
    out[k.toUpperCase()] = v;
  }
  return out;
}

// Parse unfolded ICS text into raw vevents.
export function parseICS(text) {
  const lines = unfold(text).split('\n');
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = { exdates: [] };
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur && cur.dtstart) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const left = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const [name] = left.split(';');
    switch (name.toUpperCase()) {
      case 'UID': cur.uid = value.trim(); break;
      case 'SUMMARY': cur.summary = unescapeText(value); break;
      case 'LOCATION': cur.location = unescapeText(value); break;
      case 'DTSTART': cur.dtstart = parseDate(value); break;
      case 'DTEND': cur.dtend = parseDate(value); break;
      case 'RRULE': cur.rrule = parseRRule(value); break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDate(value); break;
      case 'EXDATE':
        for (const v of value.split(',')) {
          const d = parseDate(v);
          if (d) cur.exdates.push(d);
        }
        break;
      default: break;
    }
  }
  return events;
}

function* occurrences(ev, startMs, durMs, windowEndMs, tz) {
  const r = ev.rrule;
  if (!r) {
    yield startMs;
    return;
  }
  const freq = (r.FREQ || '').toUpperCase();
  const interval = Math.max(1, parseInt(r.INTERVAL || '1', 10) || 1);
  const count = r.COUNT ? parseInt(r.COUNT, 10) : null;
  const until = r.UNTIL ? toEpochMs(parseDate(r.UNTIL), tz) : null;
  const limit = (t, n) =>
    t > windowEndMs || (until !== null && t > until) || (count !== null && n >= count);

  if (freq === 'DAILY' || (freq === 'WEEKLY' && r.BYDAY)) {
    // Walk day by day; for WEEKLY+BYDAY include matching weekdays of in-interval weeks.
    const bydays = freq === 'WEEKLY'
      ? r.BYDAY.split(',').map((d) => WEEKDAYS[d.trim().toUpperCase()]).filter((x) => x !== undefined)
      : null;
    const DAY = 86400000;
    let n = 0;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const t = startMs + i * DAY;
      if (t > windowEndMs || (until !== null && t > until)) return;
      let match;
      if (bydays) {
        const wk = Math.floor(i / 7);
        match = wk % interval === 0 && bydays.includes(new Date(t).getUTCDay());
        // first instance is always DTSTART itself per RFC
        if (i === 0) match = true;
      } else {
        match = i % interval === 0;
      }
      if (!match) continue;
      if (count !== null && n >= count) return;
      n++;
      yield t;
    }
    return;
  }

  // WEEKLY (no BYDAY) / MONTHLY / YEARLY: step the start datetime.
  const start = new Date(startMs);
  let n = 0;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let t;
    if (freq === 'WEEKLY') {
      t = startMs + i * interval * 7 * 86400000;
    } else if (freq === 'MONTHLY') {
      const d = new Date(start);
      d.setUTCMonth(d.getUTCMonth() + i * interval);
      if (d.getUTCDate() !== start.getUTCDate()) continue; // skipped short month
      t = d.getTime();
    } else if (freq === 'YEARLY') {
      const d = new Date(start);
      d.setUTCFullYear(d.getUTCFullYear() + i * interval);
      t = d.getTime();
    } else {
      if (i === 0) yield startMs; // unknown FREQ -> single occurrence
      return;
    }
    if (limit(t, n)) return;
    n++;
    yield t;
  }
}

// Expand raw vevents into concrete instances inside [windowStartMs, windowEndMs].
export function expandEvents(rawEvents, windowStartMs, windowEndMs, tz) {
  // RECURRENCE-ID overrides replace one instance of their series.
  const overridden = new Set();
  for (const ev of rawEvents) {
    if (ev.recurrenceId && ev.uid) {
      overridden.add(`${ev.uid}@${toEpochMs(ev.recurrenceId, tz)}`);
    }
  }

  const out = [];
  for (const ev of rawEvents) {
    const startMs = toEpochMs(ev.dtstart, tz);
    if (startMs === null) continue;
    const allDay = !!ev.dtstart.dateOnly;
    let durMs = allDay ? 86400000 : 3600000;
    if (ev.dtend) {
      const endMs = toEpochMs(ev.dtend, tz);
      if (endMs !== null && endMs > startMs) durMs = endMs - startMs;
    }
    const exdates = new Set(ev.exdates.map((d) => toEpochMs(d, tz)));

    for (const occ of occurrences(ev, startMs, durMs, windowEndMs, tz)) {
      if (occ + durMs <= windowStartMs || occ > windowEndMs) continue;
      if (exdates.has(occ)) continue;
      if (ev.rrule && !ev.recurrenceId && overridden.has(`${ev.uid}@${occ}`)) continue;
      out.push({
        id: `${ev.uid || 'noid'}@${Math.floor(occ / 1000)}`,
        title: ev.summary || '(untitled)',
        location: ev.location || '',
        start: Math.floor(occ / 1000),
        end: Math.floor((occ + durMs) / 1000),
        all_day: allDay,
      });
    }
  }
  out.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
  return out.slice(0, MAX_EVENTS);
}

// Fetch + merge all configured ICS feeds into one expanded agenda window.
export async function fetchAgenda(env, windowStartMs, windowEndMs, tz) {
  const urls = String(env.PROTON_ICS_URL || '').split(/[\s,]+/).filter(Boolean);
  if (!urls.length) return null;
  const texts = await Promise.all(urls.map(async (u) => {
    const r = await fetch(u, { headers: { accept: 'text/calendar' } });
    if (!r.ok) throw new Error(`ICS fetch ${r.status}`);
    return r.text();
  }));
  const raw = texts.flatMap((t) => parseICS(t));
  return expandEvents(raw, windowStartMs, windowEndMs, tz);
}
