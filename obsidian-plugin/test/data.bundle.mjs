// src/stats.ts
function weightedMean(items) {
  const valid = items.filter((i) => Number.isFinite(i.value) && i.weight > 0);
  if (!valid.length) return null;
  const wsum = valid.reduce((a, b) => a + b.weight, 0);
  if (wsum <= 0) return null;
  return valid.reduce((a, b) => a + b.value * b.weight, 0) / wsum;
}
function weightedStd(items, mean) {
  const valid = items.filter((i) => Number.isFinite(i.value) && i.weight > 0);
  if (valid.length < 2 || mean === null) return null;
  const wsum = valid.reduce((a, b) => a + b.weight, 0);
  if (wsum <= 0) return null;
  const variance = valid.reduce((a, b) => a + b.weight * (b.value - mean) ** 2, 0) / wsum;
  return Math.sqrt(variance);
}
function minMax(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  return { min: Math.min(...v), max: Math.max(...v) };
}
function tierWeight(rank, count) {
  return Math.max(1, count - rank);
}
function resolveWeight(opts) {
  if (typeof opts.override === "number" && Number.isFinite(opts.override) && opts.override >= 0) {
    return opts.override;
  }
  if (opts.mode === "equal") return 1;
  if (opts.mode === "custom") return opts.customWeight ?? 1;
  return tierWeight(opts.rank, opts.count);
}

// src/data.ts
var DEVICES = ["ultrahuman", "withings", "fitbit", "polar", "samsung"];
var DEVICE_LABEL = {
  ultrahuman: "Ultrahuman",
  withings: "Withings",
  fitbit: "Fitbit",
  polar: "Polar",
  samsung: "Samsung"
};
var DEVICE_COLOR = {
  ultrahuman: "#2e9e5b",
  withings: "#2f6fed",
  fitbit: "#19b6a8",
  polar: "#e0314b",
  samsung: "#7a5cff"
};
var hm = (min) => `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, "0")}m`;
var GROUPS = ["Sleep", "Heart", "Activity", "Metabolic", "Other"];
var METRICS = [
  { key: "sleep_total_min", label: "Sleep duration", group: "Sleep", unit: "", fmt: hm, better: "high" },
  { key: "sleep_score", label: "Sleep score", group: "Sleep", unit: "", better: "high" },
  { key: "sleep_deep_min", label: "Deep sleep", group: "Sleep", unit: "min", better: "high" },
  { key: "sleep_rem_min", label: "REM sleep", group: "Sleep", unit: "min", better: "high" },
  { key: "sleep_light_min", label: "Light sleep", group: "Sleep", unit: "min", better: "high" },
  { key: "hrv", label: "HRV", group: "Heart", unit: "ms", better: "high" },
  { key: "rhr", label: "Resting HR", group: "Heart", unit: "bpm", better: "low" },
  { key: "steps", label: "Steps", group: "Activity", unit: "", better: "high" },
  { key: "active_min", label: "Active minutes", group: "Activity", unit: "min", better: "high" },
  // Ultrahuman CGM/metabolic family (M1 sensor) — written by the exporter as
  // ultrahuman_<key>; charts/correlations only render when data is present.
  { key: "glucose_avg", label: "Avg glucose", group: "Metabolic", unit: "mg/dL", better: "low" },
  { key: "glucose_variability", label: "Glucose variability", group: "Metabolic", unit: "%", better: "low" },
  { key: "metabolic_score", label: "Metabolic score", group: "Metabolic", unit: "", better: "high" },
  { key: "hba1c", label: "HbA1c", group: "Metabolic", unit: "%", better: "low" },
  { key: "time_in_target", label: "Time in target", group: "Metabolic", unit: "%", better: "high" }
];
var METRIC_KEYS = new Set(METRICS.map((m) => m.key));
function discoverMetrics(rows) {
  const found = /* @__PURE__ */ new Set();
  for (const r of rows) {
    for (const k of Object.keys(r.values)) {
      const dev = DEVICES.find((d) => k.startsWith(d + "_"));
      if (!dev) continue;
      const metricKey = k.slice(dev.length + 1);
      if (!METRIC_KEYS.has(metricKey)) found.add(metricKey);
    }
  }
  return [...found].sort().map((key) => ({
    key,
    label: key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    group: "Other",
    unit: "",
    better: "high"
  }));
}
function loadHealthData(app, folder) {
  const prefix = folder.replace(/\/+$/, "") + "/";
  const rows = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith(prefix)) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (!fm || !fm.date) continue;
    const values = {};
    for (const k of Object.keys(fm)) {
      if (!DEVICES.some((d) => k.startsWith(d + "_"))) continue;
      const v = fm[k];
      if (typeof v === "number") values[k] = v;
      else if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) values[k] = Number(v);
    }
    rows.push({ date: String(fm.date), values });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}
function filterRange(rows, days) {
  if (!days || days <= 0) return rows;
  return rows.slice(-days);
}
function defaultPrefs() {
  const tiers = {};
  for (const m of METRICS) tiers[m.key] = [...DEVICES];
  const deviceWeights = {};
  for (const d of DEVICES) deviceWeights[d] = 1;
  return {
    folder: "Health",
    rangeDays: 60,
    weightMode: "tier",
    deviceWeights,
    tiers,
    metricWeights: {},
    habitsFolder: "",
    habitPrefix: "habit_",
    habitLagMode: "smart",
    habitList: ["supplements", "intentional_walk", "meditation"],
    dailyNoteFormat: "YYYY-MM-DD"
  };
}
function devicesForMetric(metricKey, rows, tier) {
  const present = /* @__PURE__ */ new Set();
  for (const r of rows) {
    for (const d of DEVICES) {
      if (r.values[`${d}_${metricKey}`] !== void 0) present.add(d);
    }
  }
  const ordered = tier.filter((d) => present.has(d));
  for (const d of DEVICES) if (present.has(d) && !ordered.includes(d)) ordered.push(d);
  return ordered;
}
function weightFor(device, metricKey, rank, count, prefs) {
  return resolveWeight({
    override: prefs.metricWeights?.[metricKey]?.[device],
    mode: prefs.weightMode,
    rank,
    count,
    customWeight: prefs.deviceWeights[device]
  });
}
function effectiveWeights(metricKey, devices, prefs) {
  const raw = devices.map((d, i) => ({ device: d, w: weightFor(d, metricKey, i, devices.length, prefs) }));
  const sum = raw.reduce((a, b) => a + b.w, 0);
  if (sum <= 0) return raw.map((r) => ({ device: r.device, pct: 0 }));
  return raw.map((r) => ({ device: r.device, pct: Math.round(r.w / sum * 100) }));
}
function buildMetricSeries(metric, rows, prefs) {
  const tier = prefs.tiers[metric.key] ?? [...DEVICES];
  const devices = devicesForMetric(metric.key, rows, tier).filter((d) => tier.includes(d));
  const dates = rows.map((r) => r.date);
  const perDevice = devices.map((d) => ({
    device: d,
    points: rows.map((r) => {
      const v = r.values[`${d}_${metric.key}`];
      return typeof v === "number" ? v : null;
    })
  }));
  const mean = [];
  const lower = [];
  const upper = [];
  const mn = [];
  const mx = [];
  for (const r of rows) {
    const items = [];
    const raw = [];
    devices.forEach((d, i) => {
      const v = r.values[`${d}_${metric.key}`];
      if (typeof v === "number") {
        items.push({ value: v, weight: weightFor(d, metric.key, i, devices.length, prefs) });
        raw.push(v);
      }
    });
    const m = weightedMean(items);
    const sd = weightedStd(items, m);
    const mm = minMax(raw);
    mean.push(m);
    lower.push(m !== null && sd !== null ? m - sd : null);
    upper.push(m !== null && sd !== null ? m + sd : null);
    mn.push(mm ? mm.min : null);
    mx.push(mm ? mm.max : null);
  }
  return { metric, dates, perDevice, combined: { mean, lower, upper, min: mn, max: mx } };
}
export {
  DEVICES,
  DEVICE_COLOR,
  DEVICE_LABEL,
  GROUPS,
  METRICS,
  buildMetricSeries,
  defaultPrefs,
  devicesForMetric,
  discoverMetrics,
  effectiveWeights,
  filterRange,
  loadHealthData,
  weightFor
};
