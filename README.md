# trmnl-health

A multi-source health dashboard for **TRMNL** e-ink displays **plus an automatic daily export into Obsidian**.

Forked from [Jay9185/TRMNL-ULTRAHUMAN](https://github.com/Jay9185/TRMNL-ULTRAHUMAN) and expanded:

- Pulls **Ultrahuman Ring AIR** *and* **Ultrahuman Home** (air quality) from the Partner API.
- Cloudflare Worker is the **single source of truth**: it serves the TRMNL display payload **and** a secured JSON route.
- A small **Python exporter** writes a non-destructive **Health block + Dataview inline fields** into your daily note each morning.
- Built around a **source-adapter pattern** so Withings / Fitbit / Polar (and later Samsung) plug in without rewrites.
- A **Pebble watchapp** ([`pebble/`](pebble/)) shows the same dashboard on your wrist — works with the original watches and the new [Core Devices](https://github.com/coredevices) ones.

## Architecture

```
Ultrahuman API ─┐
Withings  (LT) ─┤   Cloudflare Worker (source of truth)          TRMNL device
Fitbit    (LT) ─┼─> sources/* → aggregate → unified model ──┬──> GET /       (display JSON, polled)
Polar     (LT) ─┘     + KV cache, trends, fallback          └──> GET /json   (unified, key-gated)
                                                                     │
                                         Windows Task Scheduler ─> exporter/export.py
                                                                     │  GET /json?date=…  (X-Export-Key)
                                                                     ▼
                             Obsidian: Notes/Daily Notes/YY-MM-DD.md  (Health block + inline fields)
```

## Layout

```
src/
  index.js              # Worker routes: / (TRMNL), /json (exporter), /debug/raw (schema discovery)
  aggregate.js          # unified per-day model = the /json contract
  display.js            # unified -> flat payload TRMNL polls
  sources/ultrahuman.js # Ring (daily_metrics) + Home (home_metrics) adapters + parsers
  lib/util.js           # pure helpers (durations, trends, tz dates, weekly chart)
wrangler.toml           # Worker config (KV binding, vars; secrets set via wrangler)
trmnl-markup.liquid     # paste into the TRMNL private plugin's Markup editor
exporter/
  export.py             # fetch /json -> upsert Health block into the daily note (stdlib only)
  config.toml.example   # copy to config.toml (gitignored) and fill in
  register-task.ps1     # registers the daily Windows Scheduled Task
test/
  run.mjs               # offline worker-logic test (node test/run.mjs)
  fixtures/             # sample API + unified payloads
obsidian-plugin/        # custom multi-source dashboard plugin (per-device tabs, tiering, weighted blend)
pebble/                 # Pebble watchapp: dashboard cards on your wrist (Core Devices SDK)
```

## Setup

### Prerequisites
- **Ultrahuman** Ring (Air/R1) and, for air quality, an **Ultrahuman Home** on the same account.
- **Ultrahuman API token** — generate at <https://vision.ultrahuman.com/developer>.
- **Cloudflare** account (free) and **Node** (for `wrangler`).
- **TRMNL** device.

### 1. Deploy the Worker
```bash
npm install
npx wrangler login
npx wrangler kv namespace create KV_STORE            # paste the id into wrangler.toml
npx wrangler kv namespace create KV_STORE --preview  # paste the preview_id too
npx wrangler secret put API_TOKEN     # your Ultrahuman token
npx wrangler secret put EXPORT_KEY    # any long random string (shared with the exporter)
# set USER_TIMEZONE / HOME_ENABLED in wrangler.toml [vars]
npx wrangler deploy
```
Local dev instead: copy `.dev.vars.example` → `.dev.vars`, then `npx wrangler dev`.

### 2. Confirm the Home schema (one-time)
The Home Metrics response shape isn't in Ultrahuman's public docs, so `parseHome()` ships with a
**provisional** field map. Verify it against your real data:
```
GET https://<your-worker>/debug/raw?date=YYYY-MM-DD&key=<EXPORT_KEY>
```
Check the `home` object’s field names; if they differ, adjust the `pick([...])` lists in
[`src/sources/ultrahuman.js`](src/sources/ultrahuman.js) and redeploy.

### 3. Connect TRMNL
1. TRMNL dashboard → **Plugins → Private Plugin**, strategy **Polling**.
2. URL = `https://<your-worker>/?key=<EXPORT_KEY>` (the display is key-gated by default; set
   `PUBLIC_DISPLAY="true"` if you'd rather expose `/` without a key).
3. Paste [`trmnl-markup.liquid`](trmnl-markup.liquid) into the **Markup** editor; tune in the live preview.
4. Refresh rate 15–30 min.

### 4. Daily Obsidian export
```bash
cd exporter
cp config.toml.example config.toml      # fill worker_url, export_key, vault_path
python export.py --date 2026-05-30 --dry-run   # preview
python export.py --date 2026-05-30             # write one day
powershell -ExecutionPolicy Bypass -File .\register-task.ps1   # schedule daily 07:30
```
Each run re-syncs the last `backfill_days` days (default 3), so a missed morning or a late ring
sync self-heals. The exporter only ever rewrites the block between `<!-- HEALTH:START -->` and
`<!-- HEALTH:END -->`; the rest of your note is never touched. If the day's note doesn't exist yet
it's created from your `template_path`.

### 5. Connect Withings / Fitbit / Polar (optional)
For each service you want to add:
1. Register a developer app and set its **redirect URI** to `https://<your-worker>/callback/<source>`
   (`<source>` = `withings`, `fitbit`, or `polar`).
   - Withings — <https://developer.withings.com/>
   - Fitbit — <https://dev.fitbit.com/> (app type **Server**, OAuth 2.0)
   - Polar — <https://admin.polaraccesslink.com/>
2. Put the client id in `wrangler.toml` (`WITHINGS_CLIENT_ID`, etc.) and the secret via
   `npx wrangler secret put WITHINGS_CLIENT_SECRET` (same pattern for `FITBIT_`/`POLAR_`), then redeploy.
3. Open `https://<your-worker>/connect/<source>` in a browser and approve. Tokens are stored in KV and
   auto-refreshed (Withings/Fitbit); Polar tokens are long-lived and auto-register the AccessLink user.

Check `https://<your-worker>/status?key=<EXPORT_KEY>` to see what's connected. Connected sources show
up automatically in `/json` and in each daily note — no exporter changes needed.

### 6. Samsung Galaxy Watch (optional, push-based)
Samsung has no cloud API, so an on-device **Health Connect** bridge (HTTP Shortcuts / Tasker /
MacroDroid, or a small companion app) pushes a day's metrics:

```
POST https://<your-worker>/ingest/samsung?date=YYYY-MM-DD
Header: X-Export-Key: <EXPORT_KEY>
Body:   {"sleep":{"duration_min":430,"deep_min":70},"activity":{"steps":9000},"vitals":{"rhr":55}}
```

See [`src/sources/samsung.js`](src/sources/samsung.js) for the full accepted shape.

### 7. Wyze smart scale (optional, body composition)
Wyze has no official API, so a local Python puller reads your weigh-ins (via the
reverse-engineered `wyze-sdk`) and pushes them to the Worker — landing in **both** the
TRMNL "Body" tile and your Obsidian notes (`Wyze-*` fields).
1. `pip install wyze-sdk`
2. Generate an **API key + Key Id** at <https://developer-api-console.wyze.com> (same Wyze account).
3. Add a `[wyze]` section to `exporter/config.toml` (email, password, key_id, api_key; add
   `totp_key` **only** if your account uses an authenticator app — **SMS/email 2FA can't be automated**).
4. Verify once, then run:
   ```bash
   cd exporter
   python wyze_pull.py --debug      # dumps one weigh-in's raw fields so you can sanity-check units
   python wyze_pull.py --dry-run    # preview what would be sent
   python wyze_pull.py              # push to the Worker (register-task.ps1 schedules it daily)
   ```
Captured: weight, BMI, body fat %, muscle, body water %, BMR, visceral fat, bone mass,
metabolic age, protein. Weigh-ins are sparse, so the latest reading is carried forward and
shown "as of &lt;date&gt;". (Heads-up: it's a reverse-engineered API — it can break when Wyze
changes auth; a break only stops scale updates, the rest of the pipeline keeps working.)

### 8. Pebble watch (optional)
A native watchapp in [`pebble/`](pebble/) shows the dashboard as scrollable cards
(Sleep · Recovery · Activity · Air · Body) on any Pebble, including the new
[Core Devices](https://github.com/coredevices) Core 2 Duo / Core Time 2. The phone-side JS polls the
Worker's existing `GET /?key=…` payload, so there's nothing to deploy — build the
`.pbw`, install it, and enter your Worker URL + export key in the app's settings page.
See [`pebble/README.md`](pebble/README.md) for build instructions.

## How it works
- **GET /** — today's metrics as the flat payload TRMNL renders. Falls back to yesterday's cached
  data if the ring hasn't synced past midnight (`meta.stale = true`).
- **GET /json?date=** — the structured unified model for a given day (key-gated). What the exporter reads.
- **GET /debug/raw?date=** — raw upstream responses for schema discovery (key-gated).
- **GET /status** — which sources are configured/connected (key-gated).
- **GET /connect/:source** & **/callback/:source** — one-time OAuth linking for Withings/Fitbit/Polar.
- **POST /ingest/samsung** — accept pushed Samsung metrics (key-gated).
- **KV** caches each day's ring/home, stores per-source OAuth tokens, and runs a background **audit**
  every 3 days that backfills the last 7 days (powers the weekly step chart and HRV trend arrow).

## Status
- ✅ Ultrahuman **Ring + Home** → unified `/json`, TRMNL payload, Obsidian exporter — built & tested offline.
- ✅ **Withings / Fitbit / Polar** OAuth adapters + **Samsung** ingest — built & tested offline.
- ⏳ Remaining: deploy, then confirm a few *provisional* field maps against live data — Ultrahuman
  **Home** (via `/debug/raw`) and **Polar** sleep keys — and tune the TRMNL Liquid for the extra sources.

Adding another source later is additive: a new `src/sources/<name>.js` (normalize → unified model)
that `/json`, the TRMNL payload, and the exporter pick up automatically.

## Visualizations in Obsidian
Three layers, all fed by what the exporter writes:

1. **Inline Dataview fields** in each daily note (`UH-Sleep-Score:: 82`) → chart with the
   [Tracker](https://github.com/pyrochlore/obsidian-tracker) plugin or plain Dataview.
2. **`Health/<date>.md` frontmatter** (enable `health_folder`) → browse with core **Bases**, or render
   prebuilt charts with [health-md-visualizations](https://github.com/codybontecou/health-md-visualizations).
   Each file carries both merged keys (for that plugin) and per-device keys (`ultrahuman_hrv`, `fitbit_hrv`, …).
3. **Custom dashboard plugin** in [`obsidian-plugin/`](obsidian-plugin/) — per-device tabs, per-graph source
   **tiering**, and a **weighted holistic graph** with a ±1 SD band + min/max whiskers. Build with
   `npm install && npm run build`, then copy `main.js`/`manifest.json`/`styles.css` into
   `<vault>/.obsidian/plugins/trmnl-health-dashboard/` and add a ` ```health-dashboard ``` ` block.

**Backfill history** to populate the charts (writes only `Health/` files, leaves your journal alone):
```bash
cd exporter
python export.py --days 90 --health-only      # last 90 days of Health/<date>.md
```

## Security
This holds personal health data (heart rate, sleep, etc.), so the pipeline is locked down:
- **Every route except the OAuth callback requires `EXPORT_KEY`** (constant-time compare). `/` is
  key-gated too — put `?key=…` in the TRMNL polling URL, or set `PUBLIC_DISPLAY="true"` to open it.
- **OAuth `/connect` is key-gated** and issues a one-time, KV-stored `state` that `/callback` must
  present, so no one can silently link or hijack a data source.
- Caller-supplied **dates are validated** (`YYYY-MM-DD`) before touching KV keys or upstream URLs;
  **Samsung ingest** is allowlisted to numeric fields and size-capped, so nothing arbitrary reaches your vault.
- The display `/` is served from a short server-side cache, so polling can't amplify calls to your
  providers; unhandled errors return a generic message (no internals leaked).
- Secrets (`API_TOKEN`, `EXPORT_KEY`, client secrets, OAuth tokens) live in Cloudflare secrets/KV,
  never in code. Use an `https://` `worker_url` so `EXPORT_KEY` is never sent in cleartext.

## Credits
Forked from [Jay9185/TRMNL-ULTRAHUMAN](https://github.com/Jay9185/TRMNL-ULTRAHUMAN). MIT licensed.
