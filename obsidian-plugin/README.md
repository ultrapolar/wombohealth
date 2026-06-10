# TRMNL Health Dashboard (Obsidian plugin)

A multi-source health dashboard that renders inside an Obsidian note from the
`Health/<date>.md` files written by the [trmnl-health](../README.md) exporter.

## Features
- **Per-device tabs** — Ultrahuman, Withings, Fitbit, Polar, Samsung (only those with data), plus a **Combined** tab.
- **Per-graph source tiering** — for each metric, set which devices are included and their priority order (chips with ↑/↓/×). Priority drives the default weighting.
- **Per-metric custom weights** — each chip has a weight box; type relative weights (auto-normalized) to control the blend for *that metric only*, e.g. steps: Fitbit 40 / Polar 40 / Ultrahuman 10. Weight **0** keeps a device visible (faint line + whiskers) but removes it from the blend. A "Blend:" line shows the effective percentages; "reset weights" reverts the metric to the global mode. Per-metric weights always override the global Tier/Equal/Custom mode.
- **Holistic graph** — a weighted-mean line across devices with a **±1 SD shaded band** and **min/max whiskers**, so you see both the blended value and how much your devices disagree each day.
- **Weighting modes** — *Tier* (top-priority device counts most), *Equal*, or *Custom* (per-device sliders).
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
groups: Sleep, Heart, Activity
```
````
Range, weighting mode, custom weights, and per-graph tiers are also editable live in the dashboard and persist in plugin settings.

## How the holistic graph is computed
For each day and metric: collect every included device's reading, weight them
(per-metric weights if set, else tier rank / equal / custom sliders), then plot the
**weighted mean** with a **±1 SD** band (weighted) and **min/max** whiskers across the
readings. Whiskers and faint per-device lines always reflect *all included* devices —
even weight-0 ones — so you can see a distrusted device's reading without it skewing
the blend. Days with a single device show a line but no band/whiskers.
