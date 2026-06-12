// Habit data layer. Habits are logged by hand in note frontmatter — either
// individual keys (`habit_meditation: true`, `habit_walk_min: 25`) or a list
// (`habits: [meditation, walk]`) — typically in daily notes. This scans the
// configured folder (or the whole vault), resolves each note to a date, and
// merges everything into one row per day.
//
// A day counts as *observed* only if it has at least one habit signal (any
// `habit_*` key or a `habits:` list, even an empty one). On observed days,
// habits that aren't mentioned count as not done; days with no habit logging
// at all are excluded rather than treated as a sea of zeros.
import { App } from "obsidian";

export interface HabitDay {
  date: string; // YYYY-MM-DD
  values: Record<string, number>; // habit name -> 0/1 or quantity
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const SHORT_RE = /^(\d{2})-(\d{2})-(\d{2})$/; // daily notes named like 26-06-11

function noteDate(fmDate: unknown, basename: string): string | null {
  if (fmDate != null) {
    const s = String(fmDate).slice(0, 10);
    if (ISO_RE.test(s)) return s;
  }
  if (ISO_RE.test(basename)) return basename;
  const m = SHORT_RE.exec(basename);
  if (m) return `20${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

// Frontmatter values arrive as booleans, numbers, or strings depending on how
// the user typed them; normalize all the obvious spellings of "done".
// Exported so the quick-log modal and this loader agree on what counts as done.
export function habitValue(raw: unknown): number | null {
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

// Matches the Worker/exporter slug rule (lowercase, spaces -> _, strip
// punctuation, 40-char cap) so a habit logged from the phone and the same
// habit logged in Obsidian merge into ONE series instead of fragmenting
// ("Walk (min)" -> walk_min on both paths). Reading is lenient on one point:
// digit-first names are kept here (hand-typed `habit_5k: true` still loads)
// even though the Worker rejects them.
export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 40);
}

export function habitLabel(slug: string): string {
  const s = slug.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function loadHabits(
  app: App,
  folder: string,
  prefix: string,
  healthFolder = "",
): { days: HabitDay[]; habits: string[] } {
  const scope = folder.trim().replace(/\/+$/, "");
  const pathPrefix = scope ? scope + "/" : ""; // "" scans the whole vault
  const keyPrefix = (prefix.trim() || "habit_").toLowerCase();
  // Health/<date>.md files are regenerated from Worker data, so hand-edited
  // notes outrank them: Health values only FILL keys no other note set for the
  // day. Without this, a fat-fingered widget POST could never be un-logged
  // (the old Math.max merge ratcheted values upward forever).
  const healthPrefix = healthFolder.trim().replace(/\/+$/, "");
  const lowPriority = healthPrefix ? healthPrefix + "/" : null;
  const byDate = new Map<string, Record<string, number>>();
  const fillByDate = new Map<string, Record<string, number>>();
  const names = new Set<string>();

  for (const f of app.vault.getMarkdownFiles()) {
    if (pathPrefix && !f.path.startsWith(pathPrefix)) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (!fm) continue;

    const found: Record<string, number> = {};
    let observed = false;
    for (const [k, raw] of Object.entries(fm)) {
      const lk = k.toLowerCase();
      if (lk === "habits") {
        observed = true; // an explicit list — even [] — means "I logged today"
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

  // Health-file values fill gaps only; hand-logged values win outright.
  for (const [date, fills] of fillByDate) {
    const cur = byDate.get(date) ?? {};
    for (const [n, v] of Object.entries(fills)) {
      if (!(n in cur)) cur[n] = v;
    }
    byDate.set(date, cur);
  }

  const days = [...byDate.entries()]
    .map(([date, values]) => ({ date, values }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { days, habits: [...names].sort() };
}
