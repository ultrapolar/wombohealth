// Plugin entry point. Registers the `health-dashboard` code-block processor
// (which renders the dashboard from saved preferences plus optional per-block
// overrides), a command to insert that block, and a settings tab. Preferences
// are loaded/persisted with Obsidian's load/saveData.
import { App, Plugin, PluginSettingTab, Setting, Editor } from "obsidian";
import { Prefs, defaultPrefs, WeightMode } from "./data";
import { renderDashboard } from "./dashboard";

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

    this.addSettingTab(new HealthDashboardSettingTab(this.app, this));
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
  }
}
