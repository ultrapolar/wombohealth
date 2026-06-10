// Renders the whole dashboard into a code-block element: the top controls (date
// range, weighting mode, custom per-device weight sliders), the per-device tabs +
// a Combined tab, each metric's chart, and — on the Combined tab — the per-graph
// source-priority (tier) chips. All state lives in Prefs and is persisted via the
// save() callback; every interaction re-renders from the current Prefs.
import { App } from "obsidian";
import {
  DEVICES, DEVICE_LABEL, DEVICE_COLOR, METRICS, GROUPS, Device, Prefs, WeightMode, DayRow,
  loadHealthData, filterRange, buildMetricSeries,
} from "./data";
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
  const metricsInScope = METRICS.filter((m) => groups.includes(m.group));

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
  ];
  const active = prefs._activeTab && tabs.some((t) => t.id === prefs._activeTab) ? prefs._activeTab : "combined";

  const tabbar = root.createDiv("thd-tabs");
  tabs.forEach((t) => {
    const tb = tabbar.createEl("button", { text: t.label, cls: "thd-tab" + (t.id === active ? " active" : "") });
    if (t.id !== "combined") tb.style.borderBottomColor = t.id === active ? DEVICE_COLOR[t.id as Device] : "transparent";
    tb.onclick = async () => { prefs._activeTab = t.id; await save(); rerender(); };
  });

  const content = root.createDiv("thd-content");

  if (active === "combined") {
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
  wrap.createSpan({ text: "Priority for this graph:", cls: "thd-tierlabel" });

  if (!prefs.tiers[metricKey]) prefs.tiers[metricKey] = [...DEVICES];
  const tier = prefs.tiers[metricKey];
  const included = tier.filter((d) => presentDevices.includes(d));
  const excluded = presentDevices.filter((d) => !included.includes(d));

  included.forEach((d, idx) => {
    const chip = wrap.createSpan({ cls: "thd-chip" });
    chip.style.borderLeftColor = DEVICE_COLOR[d];
    chip.createSpan({ text: `${idx + 1}. ${DEVICE_LABEL[d]}` });
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
}
