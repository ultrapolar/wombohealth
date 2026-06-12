# trmnl-health

A multi-source health dashboard for **TRMNL** e-ink displays **plus an automatic daily export into Obsidian**.

Forked from [Jay9185/TRMNL-ULTRAHUMAN](https://github.com/Jay9185/TRMNL-ULTRAHUMAN) and expanded:

- Pulls **Ultrahuman Ring AIR** *and* **Ultrahuman Home** (air quality) from the Partner API.
- Cloudflare Worker is the **single source of truth**: it serves the TRMNL display payload **and** a secured JSON route.
- A small **Python exporter** writes a non-destructive **Health block + Dataview inline fields** into your daily note each morning.
- Built around a **source-adapter pattern** so Withings / Fitbit / Polar (and later Samsung) plug in without rewrites.

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
obsidian-plugin/        # custom multi-source dashboard plugin (per-device tabs, tiering, weighted blend, habit correlations)
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

**Polar deep recovery.** Beyond sleep basics, the Polar adapter extracts the full Nightly
Recharge™ recovery set — **ANS charge** (−10…+10, the autonomic-nervous-system recovery the
watch computes from your first 4 sleep hours), ANS charge status (1–5), Nightly Recharge
status (1–6), true RMSSD HRV (`heart-rate-variability-avg`; the mean RR interval is kept
separately), breathing rate — plus sleep structure (sleep charge, continuity, cycles,
duration/solidity/regeneration scores) and the **SleepWise™ alertness grade** (best-effort;
beta endpoint). They land as `polar_ans_charge`-style frontmatter, `Polar-Ans-Charge`
Dataview fields, and dynamic dashboard metrics with correct better-direction — all
correlatable against habits.

### 6. Samsung Galaxy Watch (optional, push-based)
Samsung has no cloud API, so an on-device **Health Connect** bridge (HTTP Shortcuts / Tasker /
MacroDroid, or a small companion app) pushes a day's metrics:

```
POST https://<your-worker>/ingest/samsung?date=YYYY-MM-DD
Header: X-Export-Key: <EXPORT_KEY>
Body:   {"sleep":{"duration_min":430,"deep_min":70},"activity":{"steps":9000},"vitals":{"rhr":55}}
```

See [`src/sources/samsung.js`](src/sources/samsung.js) for the full accepted shape.

**Wellness scores (Antioxidant Index & friends).** The ingest also accepts an `extra` group —
`antioxidant_index`, `energy_score`, `ages_index`, `stress`, `skin_temp_c` — which flows to
`samsung_antioxidant_index` frontmatter and dashboard metrics (AGEs/stress correctly treated
as lower-is-better). Reality check: sleep/steps/vitals sync to **Health Connect** where a
bridge can read them, but Samsung's proprietary scores do **not** — the Antioxidant Index
(Galaxy Watch 8 / One UI 8 Watch carotenoid measurement), Energy Score, and AGEs Index exist
only inside Samsung Health (the Samsung Health Data SDK exposes some, but it's
partner-approval-gated). Until that changes, log them with a one-tap HTTP Shortcuts widget
right after you take the measurement — same pattern as habit logging. Ingest merges per
field within each group, so a midday wellness POST composes with (never wipes) the morning
bridge's sleep/steps push.

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

## How it works
- **GET /** — today's metrics as the flat payload TRMNL renders. Falls back to yesterday's cached
  data if the ring hasn't synced past midnight (`meta.stale = true`).
- **GET /json?date=** — the structured unified model for a given day (key-gated). What the exporter reads.
- **GET /debug/raw?date=** — raw upstream responses for schema discovery (key-gated).
- **GET /status** — which sources are configured/connected (key-gated).
- **GET /connect/:source** & **/callback/:source** — one-time OAuth linking for Withings/Fitbit/Polar.
- **POST /ingest/samsung** — accept pushed Samsung metrics (key-gated).
- **POST /ingest/habits** — log healthy habits from a one-tap phone widget (key-gated;
  names slugged, values numeric-only, repeat posts merge per-key).
- **KV** caches each day's ring/home, stores per-source OAuth tokens, and runs a background **audit**
  every 3 days that backfills the last 7 days (powers the weekly step chart and HRV trend arrow).

## Status
- ✅ Ultrahuman **Ring + Home** → unified `/json`, TRMNL payload, Obsidian exporter — built & tested offline.
- ✅ **Withings / Fitbit / Polar** OAuth adapters + **Samsung** ingest — built & tested offline.
- ⏳ Remaining: deploy, then confirm a few *provisional* field maps against live data — Ultrahuman
  **Home** (via `/debug/raw`) and **Polar** sleep keys — and tune the TRMNL Liquid for the extra sources.

Adding another source later is additive: a new `src/sources/<name>.js` (normalize → unified model)
that `/json`, the TRMNL payload, and the exporter pick up automatically.

## Ultrahuman PowerPlugs & the full partner-API catalog

The app's PowerPlugs (Vitamin D tracker, Caffeine Window, Circadian alignment, AFib,
Cycle tracking, …) are **not exposed by the partner API today**. The documented catalog
(cross-checked against two independent API-schema projects) is: `hr, temp, hrv, steps,
night_rhr, avg_sleep_hrv, sleep, spo2, active_minutes, recovery_index, movement_index,
vo2_max, sleep_rhr` plus the CGM/metabolic family for M1 users: `glucose,
average_glucose, metabolic_score, glucose_variability, hba1c, time_in_target`.

What this project does about it:

- **The CGM/metabolic family is fully parsed** → `ultrahuman.metabolic` in `/json`,
  `ultrahuman_glucose_avg`-style frontmatter, `UH-Glucose-Avg` Dataview fields, and a
  "Metabolic" group in the dashboard plugin (charts + habit correlations) — all of it
  only rendering when data is present.
- **Unknown metric types pass through automatically.** Any type the Worker doesn't
  recognize whose payload carries a simple number (`value`/`avg`/`total`/`score`/`index`)
  is captured into `ultrahuman.extra` (names slugged, numbers only), written to the vault
  as `ultrahuman_<type>` frontmatter + `UH-<Type>` Dataview fields, and surfaced by the
  dashboard plugin as a dynamic metric in the "Other" group — including in the Habits
  tab's correlations. If Ultrahuman ever ships `vitamin_d` (or anything else) into the
  partner API, it appears in your vault and dashboard with **zero code changes**.
  (Direction is unknown for novel metrics, so correlation coloring assumes
  higher-is-better — treat it as a hint.)
- **Check what *your* account returns:** `GET /debug/raw?date=YYYY-MM-DD` (key-gated)
  dumps the raw upstream response — if a plug metric shows up there under a new type
  name, it's already flowing through.

Until then, two practical bridges: log plug-adjacent things as **habits with
quantities** (`habit_vitamin_d_iu: 4000`, `habit_caffeine_after_noon: 0` via the
quick-log command or `/ingest/habits`) and correlate them immediately; and if you use
**Blood Vision**, lab biomarkers (including blood vitamin D) live behind Ultrahuman's
separate UltraSignal API (`vision.ultrahuman.com/developer-docs`) — OAuth-based and
not integrated here yet.

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

## Healthy habits & correlations

Log healthy habits (supplements, meditation, intentional walks, …) and the dashboard
plugin's **Habits tab** correlates each one against the blended metrics — average
HRV/sleep/RHR on habit days vs. the rest, % difference, and Pearson r, with sleep
metrics lagged to the next morning so tonight's sleep is credited to today's habits.
Details in [`obsidian-plugin/README.md`](obsidian-plugin/README.md#habits--correlations).

Two logging paths, freely mixed (the plugin merges them per day):

**In Obsidian** — the plugin's *"Log today's habits"* command (toggle modal → daily-note
frontmatter), or type `habit_meditation: true` / `habits: [supplements, walk]` yourself.

**From your phone** — POST completions to the Worker and they flow through `/json` →
exporter → `Health/<date>.md` frontmatter automatically:
```bash
curl -X POST "https://<your-worker>/ingest/habits" \
  -H "X-Export-Key: $EXPORT_KEY" -H "Content-Type: application/json" \
  -d '{"done": ["supplements", "meditation"], "habits": {"walk_min": 25}}'   # date defaults to today
```
Make it one tap on Android with [HTTP Shortcuts](https://http-shortcuts.rmy.ch/) (a home-screen
widget per habit) or a Tasker/MacroDroid task. Names are slugged and values numeric-only on
ingest, and repeat POSTs merge per-key, so each habit can have its own button. (One caveat: the
merge is read-modify-write on eventually-consistent KV, so near-simultaneous POSTs from different
network paths can race — taps seconds apart from one phone are fine in practice, but batch
multiple habits into a single POST when you can.) (If you plan your
day in **Taskito**: it has no public API, webhooks, or automation hooks — its calendar
integration is import-only — so completions can't be read out of it directly; a one-tap
widget next to it is the practical bridge.)

**From [Loop Habit Tracker](https://github.com/iSoron/uhabits)** — keep tracking in Loop;
`exporter/import_loop.py` understands both of Loop's export formats (CSV ZIP and SQLite
backup) and POSTs each day to `/ingest/habits`. Value mapping: YES_MANUAL → done,
NO/YES_AUTO → not done that day, SKIP/UNKNOWN omitted; numerical habits de-scaled from
Loop's ×1000 storage. Loop's automation API is write-only (Tasker can *check* habits but
nothing can read checkmarks out live), so the sync is file-based — and fully schedulable:

1. **Loop** → Settings → backups → choose a *backup folder* (e.g. `Documents/LoopBackups`).
   Loop then keeps a daily `Loop Habits Backup <timestamp>.db` there automatically,
   refreshed each time you open the app (it retains the 5 newest).
2. **Sync that folder** to your computer in the background:
   [Syncthing](https://syncthing.net/) (direct, no cloud) or Autosync/FolderSync via
   Drive/Dropbox — any of them works, it's just files in a normal folder.
3. **Schedule the import** next to your existing exporter run — point it at the synced
   folder and it picks the newest backup by itself:
   ```bash
   python exporter/import_loop.py /path/to/LoopBackups/ && python exporter/export.py
   ```
   (Windows: add it to the scheduled task from `register-task.ps1`; Linux/macOS: cron.)

End to end: check habits in Loop during the day → open Loop in the morning (refreshes the
backup) → folder syncs → nightly task imports into the Worker → exporter writes
`habit_*` into the vault. No taps beyond using Loop normally. The first time, run with no
`--since` to backfill your whole Loop history, and temporarily raise `backfill_days` in
`config.toml` (or loop `export.py --date`) so the historical days materialize as
`Health/<date>.md` files.

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
