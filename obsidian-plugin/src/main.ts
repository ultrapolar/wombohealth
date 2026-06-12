// Plugin entry point. Registers the `health-dashboard` code-block processor
// (which renders the dashboard from saved preferences plus optional per-block
// overrides), a command to insert that block, and a settings tab. Preferences
// are loaded/persisted with Obsidian's load/saveData.
import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, Editor, TFile, normalizePath } from "obsidian";
import { Prefs, defaultPrefs, WeightMode } from "./data";
import { slugify, habitLabel, habitValue } from "./habits";
import { renderDashboard } from "./dashboard";

// Obsidian bundles moment and exposes it at runtime; the typed re-export isn't
// callable, so go through window.
const fmtToday = (fmt: string): string =>
  (window as unknown as { moment: () => { format(f: string): string } }).moment().format(fmt);

interface BlockConfig {
  folder?: string;
  range?: number;
  groups?: string[];
}

function parseConfig(source: string): BlockConfig {
  const cfg: BlockConfig = {};
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key === "folder") cfg.folder = val;
    else if (key === "range") cfg.range = val.toLowerCase() === "all" ? 0 : parseInt(val, 10);
    else if (key === "groups") cfg.groups = val.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return cfg;
}

export default class HealthDashboardPlugin extends Plugin {
  prefs!: Prefs;

  async onload(): Promise<void> {
    const saved = (await this.loadData()) as Partial<Prefs> | null;
    const d = defaultPrefs();
    this.prefs = Object.assign(d, saved || {});
    // Make sure nested records have all keys even if the saved blob is older.
    this.prefs.deviceWeights = Object.assign(d.deviceWeights, this.prefs.deviceWeights || {});
    this.prefs.tiers = Object.assign(d.tiers, this.prefs.tiers || {});
    this.prefs.metricWeights = this.prefs.metricWeights || {};

    this.registerMarkdownCodeBlockProcessor("health-dashboard", (source, el) => {
      const over = parseConfig(source);
      if (over.folder) this.prefs.folder = over.folder;
      if (over.range !== undefined && !Number.isNaN(over.range)) this.prefs.rangeDays = over.range;
      renderDashboard(this.app, el, this.prefs, () => this.saveData(this.prefs), over.groups);
    });

    this.addCommand({
      id: "insert-health-dashboard",
      name: "Insert health dashboard block",
      editorCallback: (editor: Editor) => editor.replaceSelection("```health-dashboard\n```\n"),
    });

    this.addCommand({
      id: "log-todays-habits",
      name: "Log today's habits",
      callback: () => new HabitLogModal(this.app, this).open(),
    });

    this.addSettingTab(new HealthDashboardSettingTab(this.app, this));
  }
}

// Quick-log: toggles for the configured habit set, written as habit_<name>
// frontmatter into today's daily note. Every listed habit gets an explicit
// true/false so the day counts as observed (false days are what make the
// "without" side of the correlation real).
class HabitLogModal extends Modal {
  plugin: HealthDashboardPlugin;
  values = new Map<string, boolean>();
  // Frontmatter keys as they actually appear in the note (e.g. "Habit_Meditation"),
  // so saving writes back to the existing key instead of a contradictory twin.
  origKeys = new Map<string, string>();
  origVals = new Map<string, unknown>();
  newHabit = "";

  constructor(app: App, plugin: HealthDashboardPlugin) {
    super(app);
    this.plugin = plugin;
  }

  notePath(): string {
    const prefs = this.plugin.prefs;
    const name = fmtToday(prefs.dailyNoteFormat || "YYYY-MM-DD");
    return normalizePath((prefs.habitsFolder ? prefs.habitsFolder + "/" : "") + name + ".md");
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    const prefs = this.plugin.prefs;
    const prefix = prefs.habitPrefix || "habit_";
    contentEl.createEl("h3", { text: `Log habits — ${fmtToday("YYYY-MM-DD")}` });
    contentEl.createDiv({ text: `→ ${this.notePath()}`, cls: "setting-item-description" });

    // Pre-fill from today's note, and include any habits already logged there
    // that aren't in the configured set. Keys are matched by slug (so a
    // hand-typed "Habit_Meditation" still pre-fills) and remembered verbatim
    // so Save writes back to the same key.
    const file = this.app.vault.getAbstractFileByPath(this.notePath());
    const fm = file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
    const names = [...prefs.habitList.map(slugify).filter(Boolean)];
    if (fm) {
      for (const k of Object.keys(fm)) {
        const lk = k.toLowerCase();
        if (!lk.startsWith(prefix)) continue;
        const n = slugify(lk.slice(prefix.length));
        if (!n) continue;
        this.origKeys.set(n, k);
        this.origVals.set(n, fm[k]);
        if (!names.includes(n)) names.push(n);
      }
    }

    for (const name of names) {
      const cur = (habitValue(this.origVals.get(name)) ?? 0) > 0;
      this.values.set(name, cur);
      const raw = this.origVals.get(name);
      const qty = typeof raw === "number" && raw > 1 ? ` (${raw})` : "";
      new Setting(contentEl)
        .setName(habitLabel(name) + qty)
        .addToggle((t) => t.setValue(cur).onChange((v) => this.values.set(name, v)));
    }

    new Setting(contentEl)
      .setName("Add a habit")
      .setDesc("Added to your habit set and logged as done today.")
      .addText((t) => t.setPlaceholder("cold shower").onChange((v) => (this.newHabit = v)));

    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Save").setCta().onClick(() => this.save()),
    );
  }

  async save(): Promise<void> {
    const prefs = this.plugin.prefs;
    const prefix = prefs.habitPrefix || "habit_";
    const extra = slugify(this.newHabit);
    if (extra) {
      this.values.set(extra, true);
      if (!prefs.habitList.includes(extra)) {
        prefs.habitList.push(extra);
        await this.plugin.saveData(prefs);
      }
    }
    const path = this.notePath();
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      const dir = path.split("/").slice(0, -1).join("/");
      if (dir && !this.app.vault.getAbstractFileByPath(dir)) {
        await this.app.vault.createFolder(dir).catch(() => {});
      }
      file = await this.app.vault.create(path, "");
    }
    await this.app.fileManager.processFrontMatter(file as TFile, (front) => {
      for (const [name, done] of this.values) {
        const key = this.origKeys.get(name) ?? prefix + name;
        const raw = this.origVals.get(name);
        // A quantity habit (habit_walk_min: 25) left "on" keeps its number —
        // only an actual toggle change overwrites it with a boolean.
        if (done && typeof raw === "number" && raw > 0) continue;
        front[key] = done;
      }
    });
    new Notice(`Logged ${[...this.values.values()].filter(Boolean).length} habit(s) for today.`);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class HealthDashboardSettingTab extends PluginSettingTab {
  plugin: HealthDashboardPlugin;

  constructor(app: App, plugin: HealthDashboardPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Health data folder")
      .setDesc("Folder of per-day Health/<date>.md files written by the trmnl-health exporter.")
      .addText((t) =>
        t.setValue(this.plugin.prefs.folder).onChange(async (v) => {
          this.plugin.prefs.folder = v.trim() || "Health";
          await this.plugin.saveData(this.plugin.prefs);
        }),
      );

    new Setting(containerEl)
      .setName("Default date range")
      .setDesc("How many recent days to show by default.")
      .addDropdown((dd) =>
        dd
          .addOptions({ "30": "30 days", "60": "60 days", "90": "90 days", "0": "All" })
          .setValue(String(this.plugin.prefs.rangeDays))
          .onChange(async (v) => {
            this.plugin.prefs.rangeDays = parseInt(v, 10);
            await this.plugin.saveData(this.plugin.prefs);
          }),
      );

    new Setting(containerEl)
      .setName("Default weighting mode")
      .setDesc("Tier = top-priority device counts most · Equal = all the same · Custom = per-device sliders.")
      .addDropdown((dd) =>
        dd
          .addOptions({ tier: "Tier", equal: "Equal", custom: "Custom" })
          .setValue(this.plugin.prefs.weightMode)
          .onChange(async (v) => {
            this.plugin.prefs.weightMode = v as WeightMode;
            await this.plugin.saveData(this.plugin.prefs);
          }),
      );

    new Setting(containerEl).setName("Habits").setHeading();

    new Setting(containerEl)
      .setName("Habits folder")
      .setDesc("Folder of notes whose frontmatter holds habit logs (e.g. your daily-notes folder). Leave empty to scan the whole vault.")
      .addText((t) =>
        t.setPlaceholder("Notes/Daily Notes").setValue(this.plugin.prefs.habitsFolder).onChange(async (v) => {
          this.plugin.prefs.habitsFolder = v.trim().replace(/\/+$/, "");
          await this.plugin.saveData(this.plugin.prefs);
        }),
      );

    new Setting(containerEl)
      .setName("Habit key prefix")
      .setDesc('Frontmatter keys starting with this are habits: "habit_meditation: true" → Meditation. A "habits: [walk, …]" list works too.')
      .addText((t) =>
        t.setValue(this.plugin.prefs.habitPrefix).onChange(async (v) => {
          this.plugin.prefs.habitPrefix = v.trim() || "habit_";
          await this.plugin.saveData(this.plugin.prefs);
        }),
      );

    new Setting(containerEl)
      .setName("Habit set")
      .setDesc('Comma-separated habits offered by the "Log today\'s habits" command and always shown on the Habits tab.')
      .addText((t) =>
        t.setValue(this.plugin.prefs.habitList.join(", ")).onChange(async (v) => {
          this.plugin.prefs.habitList = v.split(",").map(slugify).filter(Boolean);
          await this.plugin.saveData(this.plugin.prefs);
        }),
      );

    new Setting(containerEl)
      .setName("Daily note filename format")
      .setDesc('Moment format of your daily-note filenames, so the quick-log command targets the right note (e.g. "YY-MM-DD" for 26-06-11.md).')
      .addText((t) =>
        t.setPlaceholder("YYYY-MM-DD").setValue(this.plugin.prefs.dailyNoteFormat).onChange(async (v) => {
          this.plugin.prefs.dailyNoteFormat = v.trim() || "YYYY-MM-DD";
          await this.plugin.saveData(this.plugin.prefs);
        }),
      );
  }
}
