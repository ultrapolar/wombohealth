// src/habits.ts
var ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
var SHORT_RE = /^(\d{2})-(\d{2})-(\d{2})$/;
function noteDate(fmDate, basename) {
  if (fmDate != null) {
    const s = String(fmDate).slice(0, 10);
    if (ISO_RE.test(s)) return s;
  }
  if (ISO_RE.test(basename)) return basename;
  const m = SHORT_RE.exec(basename);
  if (m) return `20${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
function habitValue(raw) {
  if (typeof raw === "boolean") return raw ? 1 : 0;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (["true", "yes", "y", "done", "x"].includes(s)) return 1;
    if (["false", "no", "n", ""].includes(s)) return 0;
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
function slugify(name) {
  return name.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 40);
}
function habitLabel(slug) {
  const s = slug.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function loadHabits(app, folder, prefix, healthFolder = "") {
  const scope = folder.trim().replace(/\/+$/, "");
  const pathPrefix = scope ? scope + "/" : "";
  const keyPrefix = (prefix.trim() || "habit_").toLowerCase();
  const healthPrefix = healthFolder.trim().replace(/\/+$/, "");
  const lowPriority = healthPrefix ? healthPrefix + "/" : null;
  const byDate = /* @__PURE__ */ new Map();
  const fillByDate = /* @__PURE__ */ new Map();
  const names = /* @__PURE__ */ new Set();
  for (const f of app.vault.getMarkdownFiles()) {
    if (pathPrefix && !f.path.startsWith(pathPrefix)) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (!fm) continue;
    const found = {};
    let observed = false;
    for (const [k, raw] of Object.entries(fm)) {
      const lk = k.toLowerCase();
      if (lk === "habits") {
        observed = true;
        const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
        for (const item of list) {
          const name = slugify(String(item));
          if (name) found[name] = Math.max(found[name] ?? 0, 1);
        }
      } else if (lk.startsWith(keyPrefix)) {
        const name = slugify(lk.slice(keyPrefix.length));
        const v = habitValue(raw);
        if (name && v !== null) {
          observed = true;
          found[name] = Math.max(found[name] ?? 0, v);
        }
      }
    }
    if (!observed) continue;
    const date = noteDate(fm.date, f.basename);
    if (!date) continue;
    const tier = lowPriority && f.path.startsWith(lowPriority) ? fillByDate : byDate;
    const cur = tier.get(date) ?? {};
    for (const [n, v] of Object.entries(found)) {
      cur[n] = Math.max(cur[n] ?? 0, v);
      names.add(n);
    }
    tier.set(date, cur);
  }
  for (const [date, fills] of fillByDate) {
    const cur = byDate.get(date) ?? {};
    for (const [n, v] of Object.entries(fills)) {
      if (!(n in cur)) cur[n] = v;
    }
    byDate.set(date, cur);
  }
  const days = [...byDate.entries()].map(([date, values]) => ({ date, values })).sort((a, b) => a.date.localeCompare(b.date));
  return { days, habits: [...names].sort() };
}
export {
  habitLabel,
  habitValue,
  loadHabits,
  slugify
};
