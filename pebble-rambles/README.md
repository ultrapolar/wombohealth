# Rambles — dictate Obsidian notes from your Pebble

Hold up your watch, talk, and the note lands in your Obsidian vault's
`Rambles/` folder — routed into sections by what you say first:

| You say… | It files as | Under |
| --- | --- | --- |
| "**to do** buy oat milk" | `- [ ] buy oat milk` | `## To Do` |
| "**important** call mom tomorrow" | `- **call mom tomorrow**` | `## Important` |
| "**idea** pebble app that waters plants" | `- 14:02 — pebble app…` | `## Ideas` |
| "**question** …" | `- 14:02 — …` | `## Questions` |
| anything else | `- 14:02 — …` | `## Rambles` |

The keyword ("task" and "remember" work too) is stripped from the saved note.
One file per day (`Rambles/YYYY-MM-DD.md`); syncing is append-only and
dedup'd, so checking off a todo in Obsidian never gets clobbered.

## On the watch

The app launches straight into the system dictation UI (Core 2 Duo /
Pebble 2 / Time-series mics) — just talk. Then:

- **Preview screen**: the transcript with the auto-detected category in the
  title bar. **UP/DOWN** overrides the category, **SELECT** sends, **BACK**
  discards and re-arms the mic.
- A checkmark pops (with a double vibe) when the Worker has it; **SELECT**
  starts the next note.

Pro tip: set it as a Quick Launch (Settings → Quick Launch → Hold Down →
Rambles) so a long DOWN-press from the watchface gets you from thought to
filed note in ~3 seconds.

## Pipeline

```
watch mic ─ dictation ─> phone JS ─ POST /ingest/ramble ─> Worker (KV, keyword routing)
                                                              │  GET /rambles?days=N
Obsidian vault: Rambles/YYYY-MM-DD.md  <─ exporter/export.py ─┘
```

- The Worker routes/strips keywords authoritatively (`src/rambles.js`),
  caps note length and per-day count, and requires the `EXPORT_KEY`.
- The exporter picks rambles up on its normal daily run. For snappier sync,
  schedule an extra task: `python export.py --rambles-only` every 15 minutes
  (it's a single fast request; set `rambles_folder` in `config.toml`).

## Setup

1. Deploy the updated Worker (`npx wrangler deploy` from the repo root).
2. Install the `.pbw` (build below, or grab a release) via the Core/Pebble app.
3. In the phone app's settings for Rambles, enter the **Worker URL** and
   **Export key** (same values as the health app).
4. Set `rambles_folder = "Rambles"` in `exporter/config.toml`.

## Building

```bash
uv tool install pebble-tool && pebble sdk install latest   # once
cd pebble-rambles
pebble build        # build/pebble-rambles.pbw
```

Targets every mic-equipped platform (basalt, chalk, diorite, emery, and
flint/gabbro with the official SDK). The Core 2 Duo runs the `diorite`
binary. `aplite` (original Pebble/Steel) is excluded — no microphone.
Same modern-GCC workarounds as `pebble/` are baked into the `wscript`.
