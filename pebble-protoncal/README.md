# Proton Cal — Proton Calendar on your Pebble timeline

Replaces the Google-Calendar-shaped hole in the watch timeline with
**Proton Calendar**. Two things at once:

1. **Real timeline pins** — events are pushed to the system timeline (via the
   Rebble/Core timeline web API), so they appear in the watch's native
   timeline view with calendar layout, just like Google events do with the
   stock phone-app sync.
2. **An in-app agenda** — a Proton-purple menu grouped by day (Today /
   Tomorrow / weekday), time column, locations, and a detail card per event.
   SELECT opens an event; **long SELECT re-syncs** and re-pushes pins.

## How it gets your calendar (no Proton API needed)

Proton Calendar is end-to-end encrypted and has no public API — but it can
publish a read-only **ICS feed**: in Proton Calendar go to
**Settings → Calendars → (your calendar) → Share → Share with anyone via link**.

That URL goes on the Worker as a secret (it *is* the capability — anyone with
it can read your calendar, so it never touches the watch or phone config):

```bash
npx wrangler secret put PROTON_ICS_URL   # paste the ICS link; comma-separate several
npx wrangler deploy
```

The Worker's `GET /calendar?days=N` (key-gated) fetches the feed (cached
10 min), parses the ICS, expands recurring events (DAILY/WEEKLY incl. BYDAY,
MONTHLY, YEARLY, with INTERVAL/COUNT/UNTIL, EXDATE and RECURRENCE-ID
overrides), converts TZID/floating times using the Worker's `USER_TIMEZONE`,
and returns a sorted window. Works with any ICS URL (iCloud public links,
Fastmail, …), not just Proton.

## Setup

1. Set `PROTON_ICS_URL` + deploy the Worker (above).
2. Install the `.pbw`; in the phone app's settings enter the **Worker URL**
   and **Export key** (same as the other apps).
3. Optional toggles in settings: **Push timeline pins** (on by default) and
   the **Timeline API** endpoint (default `https://timeline-api.rebble.io`).

### Timeline pin caveat

`Pebble.getTimelineToken()` only hands out tokens to apps the phone knows
from the appstore — **sideloaded** apps may get `pins unavailable` in the
status row. The in-app agenda always works regardless. If you want pins
without publishing the app, upload it to the Rebble appstore as a private
app, or keep using the agenda view.

Pins are deduplicated and cleaned up: each sync PUTs new/changed events and
DELETEs pins whose events vanished from the feed (tracked in the phone's
localStorage).

## Building

```bash
uv tool install pebble-tool && pebble sdk install latest   # once
cd pebble-protoncal
pebble build        # build/pebble-protoncal.pbw
```

All 7 platforms build (aplite included — no mic needed here). Same
modern-GCC wscript workarounds as the sibling apps.
