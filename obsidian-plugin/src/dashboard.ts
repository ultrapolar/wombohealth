// Renders the whole dashboard into a code-block element: the top controls (date
// range, weighting mode, custom per-device weight sliders), the per-device tabs +
// a Combined tab, each metric's chart, and — on the Combined tab — the per-graph
// source-priority (tier) chips. All state lives in Prefs and is persisted via the
// save() callback; every interaction re-renders from the current Prefs.
import { App } from "obsidian";
import {
  DEVICES, DEVICE_LABEL, DEVICE_COLOR, METRICS, GROUPS, Device, Prefs, WeightMode, HabitLagMode,
  DayRow, MetricDef, loadHealthData, filterRange, buildMetricSeries, weightFor, effectiveWeights,
  discoverMetrics,
} from "./data";
import { loadHabits, habitLabel, slugify } from "./habits";
import { alignPairs, habitEffect } from "./stats";
import { renderChart } from "./chart";

function cssAccent(el: HTMLElement): string {
  const v = getComputedStyle(el).getPropertyValue("--interactive-accent").trim();
  return v || "#6c8cff";
}

function move<T>(arr: T[], item: T, delta: number): void {
  const i = arr.indexOf(item);
  if (i < 0) return;
  const j = i + delta;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}

function legend(parent: HTMLElement, items: { label: string; color: string }[]): void {
  const l = parent.createDiv("thd-legend");
  for (const it of items) {
    const span = l.createSpan();
    const dot = span.createSpan({ cls: "dot" });
    dot.style.backgroundColor = it.color;
    span.createSpan({ text: it.label });
  }
}

export function renderDashboard(
  app: App,
  root: HTMLElement,
  prefs: Prefs,
  save: () => Promise<void>,
  groupsFilter?: string[],
  forceReload = false,
): void {
  const rerender = () => renderDashboard(app, root, prefs, save, groupsFilter);
  root.empty();
  root.addClass("thd-root");

  // Tear down charts from the previous render so observers/listeners don't leak.
  const rootAny = root as unknown as {
    _thdDisposers?: Array<() => void>;
    _thdCache?: { folder: string; rows: DayRow[] };
  };
  (rootAny._thdDisposers || []).forEach((fn) => fn());
  const disposers: Array<() => void> = [];
  rootAny._thdDisposers = disposers;

  // Cache the parsed Health/ rows so tab/slider/tier interactions don't re-scan the vault.
  let rowsAll: DayRow[];
  if (!forceReload && rootAny._thdCache && rootAny._thdCache.folder === prefs.folder) {
    rowsAll = rootAny._thdCache.rows;
  } else {
    rowsAll = loadHealthData(app, prefs.folder);
    rootAny._thdCache = { folder: prefs.folder, rows: rowsAll };
  }
  const rows = filterRange(rowsAll, prefs.rangeDays);
  const accent = cssAccent(root);
  const groups = groupsFilter && groupsFilter.length ? groupsFilter : GROUPS;
  // Canonical metrics plus any dynamic ones discovered in the data (Worker
  // extras passthrough — e.g. future Ultrahuman PowerPlug metrics).
  const allMetrics = [...METRICS, ...discoverMetrics(rowsAll)];
  const metricsInScope = allMetrics.filter((m) => groups.includes(m.group));

  // ---- controls ----
  const controls = root.createDiv("thd-controls");

  const rangeSeg = controls.createDiv("thd-seg");
  ([["30d", 30], ["60d", 60], ["90d", 90], ["All", 0]] as [string, number][]).forEach(([lbl, d]) => {
    const b = rangeSeg.createEl("button", { text: lbl, cls: "thd-segbtn" + (prefs.rangeDays === d ? " active" : "") });
    b.onclick = async () => { prefs.rangeDays = d; await save(); rerender(); };
  });

  const modeSeg = controls.createDiv("thd-seg");
  ([["Tier", "tier"], ["Equal", "equal"], ["Custom", "custom"]] as [string, WeightMode][]).forEach(([lbl, mode]) => {
    const b = modeSeg.createEl("button", { text: lbl, cls: "thd-segbtn" + (prefs.weightMode === mode ? " active" : "") });
    b.onclick = async () => { prefs.weightMode = mode; await save(); rerender(); };
  });

  const refreshBtn = controls.createEl("button", { text: "↻", cls: "thd-segbtn", attr: { "aria-label": "Reload data from disk" } });
  refreshBtn.onclick = () => renderDashboard(app, root, prefs, save, groupsFilter, true);

  if (prefs.weightMode === "custom") {
    const sliders = controls.createDiv("thd-weights");
    for (const d of DEVICES) {
      const w = sliders.createDiv("thd-weight");
      const lab = w.createSpan({ text: DEVICE_LABEL[d], cls: "thd-wlabel" });
      lab.style.color = DEVICE_COLOR[d];
      const inp = w.createEl("input", {
        attr: { type: "range", min: "0", max: "5", step: "0.5", value: String(prefs.deviceWeights[d] ?? 1) },
      });
      const val = w.createSpan({ text: String(prefs.deviceWeights[d] ?? 1), cls: "thd-wval" });
      inp.addEventListener("input", () => val.setText(inp.value));
      inp.addEventListener("change", async () => { prefs.deviceWeights[d] = parseFloat(inp.value); await save(); rerender(); });
    }
  }

  if (!rows.length) {
    root.createDiv("thd-empty").setText(
      `No data found in "${prefs.folder}/". Run the trmnl-health exporter with a health_folder set, or change the folder in plugin settings.`,
    );
    return;
  }

  // ---- tabs ----
  const presentDevices = DEVICES.filter((d) => rows.some((r) => Object.keys(r.values).some((k) => k.startsWith(d + "_"))));
  const tabs: { id: string; label: string }[] = [
    ...presentDevices.map((d) => ({ id: d as string, label: DEVICE_LABEL[d] })),
    { id: "combined", label: "Combined" },
    { id: "habits", label: "Habits" },
  ];
  const active = prefs._activeTab && tabs.some((t) => t.id === prefs._activeTab) ? prefs._activeTab : "combined";

  const tabbar = root.createDiv("thd-tabs");
  tabs.forEach((t) => {
    const tb = tabbar.createEl("button", { text: t.label, cls: "thd-tab" + (t.id === active ? " active" : "") });
    if (t.id !== "combined" && t.id !== "habits") {
      tb.style.borderBottomColor = t.id === active ? DEVICE_COLOR[t.id as Device] : "transparent";
    }
    tb.onclick = async () => { prefs._activeTab = t.id; await save(); rerender(); };
  });

  const content = root.createDiv("thd-content");

  if (active === "habits") {
    renderHabitsTab(app, content, rows, metricsInScope, prefs, save, rerender);
  } else if (active === "combined") {
    content.createDiv("thd-mtitle").setText("Holistic blend — weighted mean · ±1 SD band · min/max whiskers");
    for (const m of metricsInScope) {
      const series = buildMetricSeries(m, rows, prefs);
      if (!series.perDevice.length) continue;
      const card = content.createDiv("thd-metric");
      card.createDiv("thd-mtitle").setText(m.label);
      const chartEl = card.createDiv("thd-chart");
      const faint = series.perDevice.map((pd) => ({
        name: DEVICE_LABEL[pd.device],
        color: DEVICE_COLOR[pd.device],
        points: pd.points,
        width: 1,
        dashed: true,
      }));
      disposers.push(renderChart(chartEl, {
        dates: series.dates,
        series: [...faint, { name: "Weighted mean", color: accent, points: series.combined.mean, width: 3 }],
        band: { lower: series.combined.lower, upper: series.combined.upper, color: accent },
        whiskers: { min: series.combined.min, max: series.combined.max, color: accent },
        unit: m.unit,
        fmt: m.fmt,
      }));
      legend(card, [
        ...series.perDevice.map((pd) => ({ label: DEVICE_LABEL[pd.device], color: DEVICE_COLOR[pd.device] })),
        { label: "weighted mean ± SD / min–max", color: accent },
      ]);
      tierControls(card, m.key, presentDevices, prefs, save, rerender);
    }
  } else {
    const dev = active as Device;
    for (const m of metricsInScope) {
      const points = rows.map((r) => {
        const v = r.values[`${dev}_${m.key}`];
        return typeof v === "number" ? v : null;
      });
      if (!points.some((p) => p != null)) continue;
      const card = content.createDiv("thd-metric");
      card.createDiv("thd-mtitle").setText(m.label);
      const chartEl = card.createDiv("thd-chart");
      disposers.push(renderChart(chartEl, {
        dates: rows.map((r) => r.date),
        series: [{ name: DEVICE_LABEL[dev], color: DEVICE_COLOR[dev], points, width: 2 }],
        unit: m.unit,
        fmt: m.fmt,
      }));
    }
  }
}

function tierControls(
  parent: HTMLElement,
  metricKey: string,
  presentDevices: Device[],
  prefs: Prefs,
  save: () => Promise<void>,
  rerender: () => void,
): void {
  const wrap = parent.createDiv("thd-tier");
  wrap.createSpan({ text: "Sources & weights:", cls: "thd-tierlabel" });

  if (!prefs.tiers[metricKey]) prefs.tiers[metricKey] = [...DEVICES];
  if (!prefs.metricWeights) prefs.metricWeights = {};
  const tier = prefs.tiers[metricKey];
  const included = tier.filter((d) => presentDevices.includes(d));
  const excluded = presentDevices.filter((d) => !included.includes(d));
  const overrides = prefs.metricWeights[metricKey] || {};
  const hasOverrides = included.some((d) => typeof overrides[d] === "number");

  included.forEach((d, idx) => {
    const chip = wrap.createSpan({ cls: "thd-chip" });
    chip.style.borderLeftColor = DEVICE_COLOR[d];
    chip.createSpan({ text: `${idx + 1}. ${DEVICE_LABEL[d]}` });

    // Per-metric weight (relative; auto-normalized). 0 = visible but out of the blend.
    const current = weightFor(d, metricKey, idx, included.length, prefs);
    const winp = chip.createEl("input", {
      cls: "thd-weightinput",
      attr: { type: "number", min: "0", max: "100", step: "5", value: String(current), "aria-label": `${DEVICE_LABEL[d]} weight` },
    });
    winp.addEventListener("change", async () => {
      const v = parseFloat(winp.value);
      if (!Number.isFinite(v) || v < 0) return;
      if (!prefs.metricWeights[metricKey]) prefs.metricWeights[metricKey] = {};
      prefs.metricWeights[metricKey][d] = v;
      await save();
      rerender();
    });

    const up = chip.createEl("button", { text: "↑", cls: "thd-chipbtn" });
    up.onclick = async () => { move(tier, d, -1); await save(); rerender(); };
    const dn = chip.createEl("button", { text: "↓", cls: "thd-chipbtn" });
    dn.onclick = async () => { move(tier, d, 1); await save(); rerender(); };
    const rm = chip.createEl("button", { text: "×", cls: "thd-chipbtn", attr: { "aria-label": "Exclude" } });
    rm.onclick = async () => { prefs.tiers[metricKey] = tier.filter((x) => x !== d); await save(); rerender(); };
  });

  excluded.forEach((d) => {
    const chip = wrap.createSpan({ cls: "thd-chip thd-chip-off" });
    const add = chip.createEl("button", { text: `+ ${DEVICE_LABEL[d]}`, cls: "thd-chipbtn" });
    add.onclick = async () => {
      prefs.tiers[metricKey] = [...included, d, ...excluded.filter((x) => x !== d)];
      await save();
      rerender();
    };
  });

  if (hasOverrides) {
    const reset = wrap.createEl("button", { text: "reset weights", cls: "thd-chipbtn thd-reset" });
    reset.onclick = async () => { delete prefs.metricWeights[metricKey]; await save(); rerender(); };
  }

  // Effective blend after normalization — what the weighted-mean line actually uses.
  if (included.length) {
    const blend = effectiveWeights(metricKey, included, prefs);
    const line = parent.createDiv("thd-blend");
    line.createSpan({ text: "Blend: " });
    blend.forEach(({ device, pct }, i) => {
      const s = line.createSpan({ text: `${DEVICE_LABEL[device]} ${pct}%${i < blend.length - 1 ? " · " : ""}` });
      s.style.color = pct === 0 ? "var(--text-faint)" : DEVICE_COLOR[device];
    });
  }
}

// ---------------------------------------------------------------------------
// Habits tab — correlates hand-logged habits against the blended metrics
// ---------------------------------------------------------------------------

const GOOD = "#2e9e5b";
const BAD = "#e0314b";
const MIN_PAIRS = 5; // fewer overlapping days than this and a row isn't worth showing

function lagFor(metric: MetricDef, mode: HabitLagMode): number {
  if (mode === "same") return 0;
  if (mode === "next") return 1;
  // Smart: sleep/heart are measured the night *after* the habit; activity is same-day.
  return metric.group === "Activity" ? 0 : 1;
}

function fmtMetricValue(m: MetricDef, v: number | null): string {
  if (v === null) return "—";
  if (m.fmt) return m.fmt(v);
  const rounded = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${rounded}${m.unit ? " " + m.unit : ""}`;
}

function strengthWord(r: number): string {
  const a = Math.abs(r);
  if (a >= 0.5) return "strong";
  if (a >= 0.3) return "moderate";
  if (a >= 0.15) return "weak";
  return "negligible";
}

function renderHabitsTab(
  app: App,
  content: HTMLElement,
  rows: DayRow[],
  metricsInScope: MetricDef[],
  prefs: Prefs,
  save: () => Promise<void>,
  rerender: () => void,
): void {
  const { days, habits } = loadHabits(app, prefs.habitsFolder, prefs.habitPrefix);
  const allHabits = [...new Set([...habits, ...(prefs.habitList || []).map(slugify).filter(Boolean)])];
  const first = rows[0].date;
  const last = rows[rows.length - 1].date;
  const daysInRange = days.filter((d) => d.date >= first && d.date <= last);

  const head = content.createDiv("thd-controls");
  const lagSeg = head.createDiv("thd-seg");
  ([["Smart lag", "smart"], ["Same day", "same"], ["Next morning", "next"]] as [string, HabitLagMode][]).forEach(([lbl, mode]) => {
    const b = lagSeg.createEl("button", { text: lbl, cls: "thd-segbtn" + (prefs.habitLagMode === mode ? " active" : "") });
    b.onclick = async () => { prefs.habitLagMode = mode; await save(); rerender(); };
  });
  head.createSpan({
    cls: "thd-blend",
    text: prefs.habitLagMode === "smart"
      ? "Smart: sleep & heart compare against the next morning's reading; activity against the same day."
      : prefs.habitLagMode === "next"
        ? "All metrics compare against the day after the habit."
        : "All metrics compare against the same day as the habit.",
  });

  if (!daysInRange.length) {
    const empty = content.createDiv("thd-empty");
    const where = prefs.habitsFolder ? `notes under "${prefs.habitsFolder}/"` : "any note";
    empty.createDiv().setText(
      `No habit logs found in this date range. Run the "Log today's habits" command, or add frontmatter to ${where} by hand (the note's filename or a "date" field gives the day):`,
    );
    empty.createEl("pre", {
      text: [
        "---",
        `${prefs.habitPrefix}supplements: true`,
        `${prefs.habitPrefix}meditation: true`,
        `${prefs.habitPrefix}walk_min: 25`,
        "# or as a list:",
        "habits: [supplements, meditation, walk]",
        "---",
      ].join("\n"),
    });
    empty.createDiv().setText(
      "Days without any habit entry are skipped (not assumed to be habit-free), so log something — even an empty `habits: []` — on rest days too.",
    );
    return;
  }

  // One date -> blended-mean map per metric, honoring the user's tiers/weights.
  const meanByMetric = new Map<string, Map<string, number>>();
  for (const m of metricsInScope) {
    const s = buildMetricSeries(m, rows, prefs);
    const map = new Map<string, number>();
    s.dates.forEach((dt, i) => {
      const v = s.combined.mean[i];
      if (v !== null) map.set(dt, v);
    });
    meanByMetric.set(m.key, map);
  }

  const byActivity = [...allHabits].sort((a, b) => {
    const doneCount = (h: string) => daysInRange.filter((d) => (d.values[h] ?? 0) > 0).length;
    return doneCount(b) - doneCount(a);
  });

  for (const habit of byActivity) {
    const doneN = daysInRange.filter((d) => (d.values[habit] ?? 0) > 0).length;
    const card = content.createDiv("thd-metric");
    const title = card.createDiv("thd-mtitle");
    title.setText(habitLabel(habit));
    card.createDiv("thd-blend").setText(`done ${doneN} of ${daysInRange.length} logged days in range`);

    const results = metricsInScope
      .map((m) => {
        const lag = lagFor(m, prefs.habitLagMode);
        const pairs = alignPairs(daysInRange, meanByMetric.get(m.key) ?? new Map(), habit, lag);
        return { m, lag, eff: habitEffect(pairs) };
      })
      .filter(({ eff }) => eff.n >= MIN_PAIRS)
      .sort((a, b) => Math.abs(b.eff.r ?? 0) - Math.abs(a.eff.r ?? 0));

    if (!results.length) {
      card.createDiv("thd-blend").setText(
        `Not enough days where this habit log overlaps health data (need ${MIN_PAIRS}+).`,
      );
      continue;
    }

    const table = card.createEl("table", { cls: "thd-htable" });
    const hr = table.createEl("tr");
    for (const h of ["Metric", "With habit", "Without", "Δ", "Correlation"]) hr.createEl("th", { text: h });

    for (const { m, lag, eff } of results) {
      const tr = table.createEl("tr");
      tr.createEl("td", { text: m.label + (lag ? " (next AM)" : "") });
      tr.createEl("td", { text: fmtMetricValue(m, eff.doneMean) + (eff.doneN ? ` (${eff.doneN}d)` : "") });
      tr.createEl("td", { text: fmtMetricValue(m, eff.restMean) + (eff.restN ? ` (${eff.restN}d)` : "") });

      const dTd = tr.createEl("td");
      if (eff.diffPct !== null) {
        const up = eff.diffPct > 0;
        dTd.setText(`${up ? "+" : ""}${Math.round(eff.diffPct)}%`);
        if (Math.abs(eff.diffPct) >= 1) {
          dTd.style.color = up === (m.better === "high") ? GOOD : BAD;
        }
      } else {
        dTd.setText("—");
      }

      const rTd = tr.createEl("td");
      if (eff.r !== null) {
        const favorable = eff.r > 0 === (m.better === "high");
        rTd.setText(`r ${eff.r >= 0 ? "+" : ""}${eff.r.toFixed(2)} · ${strengthWord(eff.r)}`);
        if (Math.abs(eff.r) >= 0.15) {
          rTd.style.color = favorable ? GOOD : BAD;
          if (Math.abs(eff.r) >= 0.3) rTd.style.fontWeight = "600";
        } else {
          rTd.style.color = "var(--text-faint)";
        }
      } else {
        rTd.setText(eff.doneN < 3 || eff.restN < 3 ? "needs 3+ days each side" : "—");
        rTd.style.color = "var(--text-faint)";
      }
    }
  }

  content.createDiv("thd-blend").setText(
    "Green = the habit lines up with the metric improving (direction-aware: lower resting HR counts as better). " +
    "These are observational correlations over your own days — small samples swing a lot, and correlation isn't causation.",
  );
}
