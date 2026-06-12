// Data layer for the dashboard. Defines the devices and canonical metrics,
// loads each day's `Health/<date>.md` frontmatter into rows (reading per-device
// keys like `ultrahuman_hrv`, `fitbit_hrv`), and builds each metric's series:
// the per-device lines plus the weighted holistic blend (mean, ±SD band, min/max)
// computed from the user's per-graph tier and weighting preferences.
import { App } from "obsidian";
import { weightedMean, weightedStd, minMax, resolveWeight, Weighted } from "./stats";

export const DEVICES = ["ultrahuman", "withings", "fitbit", "polar", "samsung"] as const;
export type Device = (typeof DEVICES)[number];

export const DEVICE_LABEL: Record<Device, string> = {
  ultrahuman: "Ultrahuman",
  withings: "Withings",
  fitbit: "Fitbit",
  polar: "Polar",
  samsung: "Samsung",
};

export const DEVICE_COLOR: Record<Device, string> = {
  ultrahuman: "#2e9e5b",
  withings: "#2f6fed",
  fitbit: "#19b6a8",
  polar: "#e0314b",
  samsung: "#7a5cff",
};

export interface MetricDef {
  key: string;
  label: string;
  group: string;
  unit: string;
  fmt?: (v: number) => string;
  // Which direction is an improvement — lets the Habits tab color a correlation
  // as favorable/unfavorable (a habit that *lowers* resting HR is a good thing).
  better: "high" | "low";
}

const hm = (min: number) => `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, "0")}m`;

export const GROUPS = ["Sleep", "Heart", "Activity", "Metabolic", "Other"];

export const METRICS: MetricDef[] = [
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
  { key: "time_in_target", label: "Time in target", group: "Metabolic", unit: "%", better: "high" },
];

const METRIC_KEYS = new Set(METRICS.map((m) => m.key));

// Known extras get a proper label and correlation direction; anything else
// defaults to "higher is better" (treat those colors as hints).
const KNOWN_DYNAMIC: Record<string, Partial<MetricDef>> = {
  // Polar Nightly Recharge / sleep structure / SleepWise
  ans_charge: { label: "ANS charge", better: "high" },
  ans_charge_status: { label: "ANS charge status", better: "high" },
  nightly_recharge_status: { label: "Nightly Recharge status", better: "high" },
  sleep_charge: { label: "Sleep charge", better: "high" },
  sleep_continuity: { label: "Sleep continuity", better: "high" },
  alertness_grade: { label: "Alertness grade (SleepWise)", better: "high" },
  beat_to_beat_avg: { label: "Mean RR interval", unit: "ms", better: "high" },
  // Samsung wellness scores
  antioxidant_index: { label: "Antioxidant index", better: "high" },
  energy_score: { label: "Energy score", better: "high" },
  ages_index: { label: "AGEs index", better: "low" },
  stress: { label: "Stress", better: "low" },
};

// Frontmatter keys like `ultrahuman_vitamin_d` or `polar_ans_charge` that aren't
// canonical metrics are the Worker's extras passthrough (new upstream metric
// types, secondary-source recovery/wellness scores). Surface them as dynamic
// metrics in the "Other" group so they chart and correlate with habits without
// a plugin update.
export function discoverMetrics(rows: DayRow[]): MetricDef[] {
  const found = new Set<string>();
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
    better: "high" as const,
    ...KNOWN_DYNAMIC[key],
  }));
}

export interface DayRow {
  date: string;
  values: Partial<Record<string, number>>; // key = `${device}_${metric}`
}

export function loadHealthData(app: App, folder: string): DayRow[] {
  const prefix = folder.replace(/\/+$/, "") + "/";
  const rows: DayRow[] = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (!f.path.startsWith(prefix)) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (!fm || !fm.date) continue;
    const values: Partial<Record<string, number>> = {};
    // Capture every numeric device-namespaced key, not just the canonical set,
    // so extras passed through by the Worker become dynamic metrics.
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

export function filterRange(rows: DayRow[], days: number): DayRow[] {
  if (!days || days <= 0) return rows;
  return rows.slice(-days);
}

export type WeightMode = "tier" | "equal" | "custom";

// How habit days line up with metric days. "smart" = sleep/heart metrics use the
// next morning's reading (a habit's effect lands in that night's sleep), activity
// uses the same day; "same"/"next" force one lag for everything.
export type HabitLagMode = "smart" | "same" | "next";

export interface Prefs {
  folder: string;
  rangeDays: number; // 0 = all
  weightMode: WeightMode;
  deviceWeights: Record<Device, number>; // used in "custom" mode
  tiers: Record<string, Device[]>; // per metric: ordered list of included devices (top = priority 1)
  // Per-metric, per-device weight overrides (relative; auto-normalized). When set for a
  // metric they take precedence over weightMode — e.g. steps: {fitbit:40, polar:40, ultrahuman:10}.
  metricWeights: Record<string, Partial<Record<Device, number>>>;
  habitsFolder: string; // where habit frontmatter lives; "" = whole vault
  habitPrefix: string; // frontmatter key prefix, default "habit_"
  habitLagMode: HabitLagMode;
  habitList: string[]; // default set shown in the quick-log modal and the Habits tab
  dailyNoteFormat: string; // moment format of daily-note filenames, for the quick-log target
  _activeTab?: string;
}

export function defaultPrefs(): Prefs {
  const tiers: Record<string, Device[]> = {};
  for (const m of METRICS) tiers[m.key] = [...DEVICES];
  const deviceWeights = {} as Record<Device, number>;
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
    dailyNoteFormat: "YYYY-MM-DD",
  };
}

// Devices that have at least one reading for `metricKey`, ordered by the tier list.
export function devicesForMetric(metricKey: string, rows: DayRow[], tier: Device[]): Device[] {
  const present = new Set<Device>();
  for (const r of rows) {
    for (const d of DEVICES) {
      if (r.values[`${d}_${metricKey}`] !== undefined) present.add(d);
    }
  }
  const ordered = tier.filter((d) => present.has(d));
  for (const d of DEVICES) if (present.has(d) && !ordered.includes(d)) ordered.push(d);
  return ordered;
}

export interface MetricSeries {
  metric: MetricDef;
  dates: string[];
  perDevice: { device: Device; points: (number | null)[] }[];
  combined: {
    mean: (number | null)[];
    lower: (number | null)[];
    upper: (number | null)[];
    min: (number | null)[];
    max: (number | null)[];
  };
}

export function weightFor(device: Device, metricKey: string, rank: number, count: number, prefs: Prefs): number {
  return resolveWeight({
    override: prefs.metricWeights?.[metricKey]?.[device],
    mode: prefs.weightMode,
    rank,
    count,
    customWeight: prefs.deviceWeights[device],
  });
}

// Normalized blend percentages for display (e.g. "Fitbit 44% · Polar 44% · UH 11%").
export function effectiveWeights(metricKey: string, devices: Device[], prefs: Prefs): { device: Device; pct: number }[] {
  const raw = devices.map((d, i) => ({ device: d, w: weightFor(d, metricKey, i, devices.length, prefs) }));
  const sum = raw.reduce((a, b) => a + b.w, 0);
  if (sum <= 0) return raw.map((r) => ({ device: r.device, pct: 0 }));
  return raw.map((r) => ({ device: r.device, pct: Math.round((r.w / sum) * 100) }));
}

export function buildMetricSeries(metric: MetricDef, rows: DayRow[], prefs: Prefs): MetricSeries {
  const tier = prefs.tiers[metric.key] ?? [...DEVICES];
  const devices = devicesForMetric(metric.key, rows, tier).filter((d) => tier.includes(d));
  const dates = rows.map((r) => r.date);

  const perDevice = devices.map((d) => ({
    device: d,
    points: rows.map((r) => {
      const v = r.values[`${d}_${metric.key}`];
      return typeof v === "number" ? v : null;
    }),
  }));

  const mean: (number | null)[] = [];
  const lower: (number | null)[] = [];
  const upper: (number | null)[] = [];
  const mn: (number | null)[] = [];
  const mx: (number | null)[] = [];

  for (const r of rows) {
    const items: Weighted[] = [];
    const raw: number[] = [];
    devices.forEach((d, i) => {
      const v = r.values[`${d}_${metric.key}`];
      if (typeof v === "number") {
        items.push({ value: v, weight: weightFor(d, metric.key, i, devices.length, prefs) });
        raw.push(v); // raw spread keeps weight-0 devices, so whiskers show full disagreement
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
