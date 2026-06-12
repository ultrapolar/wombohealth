# TRMNL Health Dashboard (Obsidian plugin)

A multi-source health dashboard that renders inside an Obsidian note from the
`Health/<date>.md` files written by the [trmnl-health](../README.md) exporter.

## Features
- **Per-device tabs** — Ultrahuman, Withings, Fitbit, Polar, Samsung (only those with data), plus a **Combined** tab.
- **Per-graph source tiering** — for each metric, set which devices are included and their priority order (chips with ↑/↓/×). Priority drives the default weighting.
- **Per-metric custom weights** — each chip has a weight box; type relative weights (auto-normalized) to control the blend for *that metric only*, e.g. steps: Fitbit 40 / Polar 40 / Ultrahuman 10. Weight **0** keeps a device visible (faint line + whiskers) but removes it from the blend. A "Blend:" line shows the effective percentages; "reset weights" reverts the metric to the global mode. Per-metric weights always override the global Tier/Equal/Custom mode.
- **Holistic graph** — a weighted-mean line across devices with a **±1 SD shaded band** and **min/max whiskers**, so you see both the blended value and how much your devices disagree each day.
- **Weighting modes** — *Tier* (top-priority device counts most), *Equal*, or *Custom* (per-device sliders).
- **Habits tab** — log healthy habits (supplements, meditation, intentional walks, …) in your daily notes' frontmatter and the dashboard correlates each habit against your blended metrics: average with vs. without the habit, % difference, and a point-biserial/Pearson r — direction-aware coloring (a habit that *lowers* resting HR shows green) and a smart day-lag (sleep/HRV compare against the *next morning's* reading).
- Dependency-free canvas charts (theme-aware, hover tooltips). Metrics: Sleep (duration, stages, score), Heart (HRV, resting HR), Activity (steps, active minutes).

## Data requirement
Run the exporter with a `health_folder` set so each day produces
`Health/YYYY-MM-DD.md` with per-device frontmatter keys like `ultrahuman_hrv`,
`fitbit_hrv`, `polar_hrv`, `withings_rhr`, … The plugin reads those keys.

## Build
```bash
npm install
npm run build      # type-checks, then bundles -> main.js
npm test           # unit-tests the blending math
```

## Install into your vault
Copy `main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/trmnl-health-dashboard/`, then enable it in
**Settings → Community plugins**. (Or use the BRAT plugin pointing at this repo.)

## Use
Add a code block to any note:
````md
```health-dashboard
```
````
Optional overrides inside the block:
````md
```health-dashboard
folder: Health
range: 90        # 30 / 60 / 90 / all
groups: Sleep, Heart, Activity, Metabolic, Other
```
````
Range, weighting mode, custom weights, and per-graph tiers are also editable live in the dashboard and persist in plugin settings.

Beyond the canonical groups, **Metabolic** carries the Ultrahuman CGM family
(avg glucose, variability, metabolic score, HbA1c, time in target) and **Other**
holds *dynamic metrics*: any `ultrahuman_<name>` (or other device-prefixed) frontmatter
key the exporter wrote that isn't canonical — e.g. new Ultrahuman metric types passed
through by the Worker — charts and correlates automatically, no plugin update needed.
Novel metrics default to "higher is better" for correlation coloring, so read those
colors as hints.

## Habits & correlations
Log habits as frontmatter in any note that resolves to a day — daily notes work as-is
(date from the filename, `YYYY-MM-DD` or `YY-MM-DD`, or a `date:` field):

```yaml
---
habit_supplements: true
habit_meditation: true
habit_walk_min: 25        # quantities work too — correlated as a continuous value
# or the list form (each entry = done):
habits: [supplements, meditation, walk]
---
```

Three ways to log:
1. **"Log today's habits" command** — a quick modal with a toggle per habit in your
   configured set (defaults: supplements, intentional walk, meditation; edit in
   settings, or add new ones from the modal). Writes explicit `true`/`false` for
   every habit into today's daily note, which keeps the "without" days honest.
2. **By hand** — type the frontmatter yourself, anywhere.
3. **From your phone** — POST to the Worker's `/ingest/habits` (one-tap widget via
   HTTP Shortcuts / Tasker); the exporter then writes `habit_*` keys into
   `Health/<date>.md`, which this plugin picks up automatically. See the
   [main README](../README.md#healthy-habits--correlations).

The **Habits** tab then shows, per habit, every metric's average on habit days vs.
the rest, the % difference, and the correlation r over the selected date range —
computed against the same weighted multi-device blend the Combined tab plots.

Everything is also plain frontmatter/inline fields, so ad-hoc Dataview works too:

````md
```dataview
TABLE UH-HRV AS "HRV", UH-Sleep-Score AS "Sleep", habit_meditation AS "Meditated"
FROM "Notes/Daily Notes"
WHERE habit_meditation != null
SORT file.name DESC
```
````

Details that matter for honest numbers:
- **Observed days only.** A day counts only if it has *some* habit entry; days you
  didn't log anything are skipped, not assumed habit-free. On rest days log an empty
  `habits: []` (or `habit_x: false`) so "without" days exist.
- **Day lag.** *Smart* (default) compares sleep/heart metrics against the **next
  morning's** reading — tonight's sleep reflects today's habits — and activity
  against the same day. Force *Same day* or *Next morning* with the toggle.
- **Gating.** A metric row needs 5+ overlapping days, and r/Δ% need 3+ days on each
  side of the split, before anything is reported.
- **Direction-aware coloring.** Green means "lines up with this metric improving"
  (higher HRV, lower resting HR), red the opposite. Correlation still isn't causation.

Settings: **Habits folder** (default: whole vault — point it at your daily-notes
folder to keep the scan tight), **Habit key prefix** (default `habit_`), **Habit
set** (the quick-log toggles), and **Daily note filename format** (moment format,
e.g. `YY-MM-DD`, so the quick-log command writes to the right note).

Don't put habit keys in the exporter-written `Health/<date>.md` files — those are
regenerated on every sync and your edits would be overwritten.

## How the holistic graph is computed
For each day and metric: collect every included device's reading, weight them
(per-metric weights if set, else tier rank / equal / custom sliders), then plot the
**weighted mean** with a **±1 SD** band (weighted) and **min/max** whiskers across the
readings. Whiskers and faint per-device lines always reflect *all included* devices —
even weight-0 ones — so you can see a distrusted device's reading without it skewing
the blend. Days with a single device show a line but no band/whiskers.
