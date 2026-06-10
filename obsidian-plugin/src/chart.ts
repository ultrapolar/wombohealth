// Dependency-free canvas line chart with an optional shaded band (±SD), min/max
// whiskers, multiple series, axes, and a hover tooltip. Theme-aware via CSS vars.

export interface Series {
  name: string;
  color: string;
  points: (number | null)[];
  width?: number;
  dashed?: boolean;
}

export interface ChartOpts {
  dates: string[];
  series: Series[];
  band?: { lower: (number | null)[]; upper: (number | null)[]; color: string };
  whiskers?: { min: (number | null)[]; max: (number | null)[]; color: string };
  height?: number;
  unit?: string;
  fmt?: (v: number) => string;
}

function cssVar(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

function niceNum(range: number, round: boolean): number {
  const r = range || 1;
  const exp = Math.floor(Math.log10(r));
  const f = r / Math.pow(10, exp);
  let nf: number;
  if (round) nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  else nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nf * Math.pow(10, exp);
}

export function renderChart(container: HTMLElement, opts: ChartOpts): () => void {
  const height = opts.height ?? 240;
  const canvas = container.createEl("canvas");
  const fmt = opts.fmt ?? ((v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1)));

  const textColor = cssVar(container, "--text-muted", "#888");
  const gridColor = cssVar(container, "--background-modifier-border", "rgba(128,128,128,0.25)");
  const tipBg = cssVar(container, "--background-secondary", "#222");
  const tipFg = cssVar(container, "--text-normal", "#eee");

  let hoverIdx = -1;
  let xmap = { padL: 48, plotW: 1, n: 0 };

  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const width = container.clientWidth || 600;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const padL = 48;
    const padR = 12;
    const padT = 10;
    const padB = 36;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;
    const n = opts.dates.length;

    const all: number[] = [];
    const pushAll = (arr?: (number | null)[]) => {
      if (arr) for (const p of arr) if (p != null) all.push(p);
    };
    for (const s of opts.series) pushAll(s.points);
    pushAll(opts.band?.lower);
    pushAll(opts.band?.upper);
    pushAll(opts.whiskers?.min);
    pushAll(opts.whiskers?.max);

    if (!all.length) {
      ctx.fillStyle = textColor;
      ctx.font = "13px var(--font-interface, sans-serif)";
      ctx.textAlign = "center";
      ctx.fillText("No data", width / 2, height / 2);
      return;
    }

    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (lo === hi) { lo -= 1; hi += 1; }
    const tick = niceNum((hi - lo) / 5, true);
    const glo = Math.floor(lo / tick) * tick;
    const ghi = Math.ceil(hi / tick) * tick;

    const xAt = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const yAt = (v: number) => padT + plotH - ((v - glo) / (ghi - glo || 1)) * plotH;
    xmap = { padL, plotW, n };

    // gridlines + y labels
    ctx.font = "11px var(--font-interface, sans-serif)";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let v = glo; v <= ghi + 1e-9; v += tick) {
      const yy = yAt(v);
      ctx.strokeStyle = gridColor;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, yy);
      ctx.lineTo(width - padR, yy);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = textColor;
      ctx.fillText(fmt(v), padL - 6, yy);
    }

    // x labels (sparse, MM-DD)
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const step = Math.max(1, Math.ceil(n / 6));
    for (let i = 0; i < n; i += step) {
      ctx.fillStyle = textColor;
      ctx.fillText((opts.dates[i] || "").slice(5), xAt(i), height - padB + 6);
    }

    // band (±SD)
    if (opts.band) {
      ctx.fillStyle = opts.band.color;
      ctx.globalAlpha = 0.16;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        const u = opts.band.upper[i];
        if (u == null) continue;
        const px = xAt(i);
        const py = yAt(u);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      for (let i = n - 1; i >= 0; i--) {
        const l = opts.band.lower[i];
        if (l == null) continue;
        ctx.lineTo(xAt(i), yAt(l));
      }
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // whiskers (min/max)
    if (opts.whiskers) {
      ctx.strokeStyle = opts.whiskers.color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      for (let i = 0; i < n; i++) {
        const mn = opts.whiskers.min[i];
        const mx = opts.whiskers.max[i];
        if (mn == null || mx == null) continue;
        const px = xAt(i);
        ctx.beginPath();
        ctx.moveTo(px, yAt(mx));
        ctx.lineTo(px, yAt(mn));
        ctx.moveTo(px - 3, yAt(mx));
        ctx.lineTo(px + 3, yAt(mx));
        ctx.moveTo(px - 3, yAt(mn));
        ctx.lineTo(px + 3, yAt(mn));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // series lines
    for (const s of opts.series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width ?? 2;
      ctx.setLineDash(s.dashed ? [4, 4] : []);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        const p = s.points[i];
        if (p == null) { started = false; continue; }
        const px = xAt(i);
        const py = yAt(p);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // hover guide + tooltip
    if (hoverIdx >= 0 && hoverIdx < n) {
      const px = xAt(hoverIdx);
      ctx.strokeStyle = textColor;
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.moveTo(px, padT);
      ctx.lineTo(px, padT + plotH);
      ctx.stroke();
      ctx.globalAlpha = 1;

      const lines = [opts.dates[hoverIdx]];
      for (const s of opts.series) {
        const p = s.points[hoverIdx];
        if (p != null) lines.push(`${s.name}: ${fmt(p)}${opts.unit ? " " + opts.unit : ""}`);
      }
      ctx.font = "11px var(--font-interface, sans-serif)";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 12;
      const th = lines.length * 14 + 8;
      let tx = px + 8;
      if (tx + tw > width - padR) tx = px - 8 - tw;
      const ty = padT + 4;
      ctx.fillStyle = tipBg;
      ctx.globalAlpha = 0.96;
      ctx.fillRect(tx, ty, tw, th);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = gridColor;
      ctx.strokeRect(tx, ty, tw, th);
      ctx.fillStyle = tipFg;
      lines.forEach((l, i) => ctx.fillText(l, tx + 6, ty + 4 + i * 14));
    }
  };

  const onMove = (e: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const rel = e.clientX - rect.left;
    const i = xmap.n <= 1 ? 0 : Math.round(((rel - xmap.padL) / xmap.plotW) * (xmap.n - 1));
    const clamped = Math.max(0, Math.min(xmap.n - 1, i));
    if (clamped !== hoverIdx) { hoverIdx = clamped; draw(); }
  };
  const onLeave = () => { hoverIdx = -1; draw(); };
  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("mouseleave", onLeave);

  draw();

  let ro: ResizeObserver | undefined;
  try {
    ro = new ResizeObserver(() => draw());
    ro.observe(container);
  } catch {
    /* ResizeObserver unavailable — static render is fine */
  }

  // Cleanup — call before discarding the chart so observers/listeners don't leak
  // across re-renders (tab switches, slider drags).
  return () => {
    ro?.disconnect();
    canvas.removeEventListener("mousemove", onMove);
    canvas.removeEventListener("mouseleave", onLeave);
  };
}
