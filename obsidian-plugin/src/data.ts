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
}

const hm = (min: number) => `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, "0")}m`;

export const GROUPS = ["Sleep", "Heart", "Activity"];

export const METRICS: MetricDef[] = [
  { key: "sleep_total_min", label: "Sleep duration", group: "Sleep", unit: "", fmt: hm },
  { key: "sleep_score", label: "Sleep score", group: "Sleep", unit: "" },
  { key: "sleep_deep_min", label: "Deep sleep", group: "Sleep", unit: "min" },
  { key: "sleep_rem_min", label: "REM sleep", group: "Sleep", unit: "min" },
  { key: "sleep_light_min", label: "Light sleep", group: "Sleep", unit: "min" },
  { key: "hrv", label: "HRV", group: "Heart", unit: "ms" },
  { key: "rhr", label: "Resting HR", group: "Heart", unit: "bpm" },
  { key: "steps", label: "Steps", group: "Activity", unit: "" },
  { key: "active_min", label: "Active minutes", group: "Activity", unit: "min" },
];

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
    for (const d of DEVICES) {
      for (const m of METRICS) {
        const k = `${d}_${m.key}`;
        const v = fm[k];
        if (typeof v === "number") values[k] = v;
        else if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) values[k] = Number(v);
      }
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

export interface Prefs {
  folder: string;
  rangeDays: number; // 0 = all
  weightMode: WeightMode;
  deviceWeights: Record<Device, number>; // used in "custom" mode
  tiers: Record<string, Device[]>; // per metric: ordered list of included devices (top = priority 1)
  // Per-metric, per-device weight overrides (relative; auto-normalized). When set for a
  // metric they take precedence over weightMode — e.g. steps: {fitbit:40, polar:40, ultrahuman:10}.
  metricWeights: Record<string, Partial<Record<Device, number>>>;
  _activeTab?: string;
}

export function defaultPrefs(): Prefs {
  const tiers: Record<string, Device[]> = {};
  for (const m of METRICS) tiers[m.key] = [...DEVICES];
  const deviceWeights = {} as Record<Device, number>;
  for (const d of DEVICES) deviceWeights[d] = 1;
  return { folder: "Health", rangeDays: 60, weightMode: "tier", deviceWeights, tiers, metricWeights: {} };
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
