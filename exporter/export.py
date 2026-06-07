#!/usr/bin/env python3
"""Daily Obsidian exporter for the trmnl-health unified JSON.

Fetches the Worker's GET /json for one or more days and writes a non-destructive
"Health" block (human summary + Dataview inline fields) into the matching daily
note. Idempotent: re-running replaces the managed block between the HTML markers,
never touching the rest of the note. Creates the note from your template if it
doesn't exist yet.

Usage:
  python export.py                         # backfill last N days (config) from the Worker
  python export.py --date 2026-05-30       # one specific day
  python export.py --dry-run               # print, don't write
  python export.py --input sample.json --date 2026-05-30 --vault /tmp/vault  # offline test

Config: exporter/config.toml (copy from config.toml.example). CLI flags override it.
No third-party dependencies (Python 3.11+ stdlib: urllib, tomllib).
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import urllib.request
import urllib.error
from datetime import date, datetime, timedelta
from pathlib import Path

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover
    tomllib = None

START = "<!-- HEALTH:START -->"
END = "<!-- HEALTH:END -->"

log = logging.getLogger("exporter")


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
def load_config(path: Path) -> dict:
    if path and path.exists() and tomllib:
        with path.open("rb") as f:
            return tomllib.load(f)
    return {}


# --------------------------------------------------------------------------- #
# Fetch
# --------------------------------------------------------------------------- #
def fetch_json(worker_url: str, key: str | None, date_iso: str, timeout: int = 20) -> dict:
    url = f"{worker_url.rstrip('/')}/json?date={date_iso}"
    headers = {"X-Export-Key": key} if key else {}
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# --------------------------------------------------------------------------- #
# Render
# --------------------------------------------------------------------------- #
def _disp(v, dash="—"):
    return dash if v is None or v == "" else v


def _min(sec):
    return round(sec / 60) if sec else None


def fmt_dur(sec):
    if not sec or sec <= 0:
        return "—"
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    return f"{h}h {m:02d}m"


def fmt_min(m):
    if not m or m <= 0:
        return "—"
    return f"{int(m) // 60}h {int(m) % 60:02d}m"


# Secondary sources rendered when present in /json.
SECONDARY = (("Withings", "withings"), ("Fitbit", "fitbit"), ("Polar", "polar"), ("Samsung", "samsung"))


def first(*vals):
    for v in vals:
        if v is not None:
            return v
    return None


def _h(sec=None, minutes=None):
    """Convert seconds or minutes to decimal hours (the health-md-visualizations sleep unit)."""
    if sec is not None:
        return round(sec / 3600, 2)
    if minutes is not None:
        return round(minutes / 60, 2)
    return None


def _sv(src, *path):
    d = src
    for k in path:
        if not isinstance(d, dict):
            return None
        d = d.get(k)
    return d


# Canonical per-device metrics for the multi-source dashboard plugin.
CANONICAL_METRICS = (
    "sleep_score", "sleep_total_min", "sleep_deep_min", "sleep_rem_min",
    "sleep_light_min", "hrv", "rhr", "steps", "active_min",
)


def _canonical_per_device(data: dict) -> dict:
    """Pull each device's value for every canonical metric (None when absent)."""
    def m(sec):
        return round(sec / 60) if sec else None

    uh = data.get("ultrahuman") or {}
    us = uh.get("sleep") or {}
    ua = uh.get("activity") or {}
    out = {
        "ultrahuman": {
            "sleep_score": us.get("score"),
            "sleep_total_min": us.get("duration_min"),
            "sleep_deep_min": m(us.get("deep_sec")),
            "sleep_rem_min": m(us.get("rem_sec")),
            "sleep_light_min": m(us.get("light_sec")),
            "hrv": us.get("hrv"),
            "rhr": us.get("rhr"),
            "steps": ua.get("steps"),
            "active_min": ua.get("active_min"),
        }
    }
    for dev in ("withings", "fitbit", "polar", "samsung"):
        src = data.get(dev)
        if not src:
            continue
        sl = src.get("sleep") or {}
        ac = src.get("activity") or {}
        vi = src.get("vitals") or {}
        out[dev] = {
            "sleep_score": sl.get("score"),
            "sleep_total_min": sl.get("duration_min"),
            "sleep_deep_min": sl.get("deep_min"),
            "sleep_rem_min": sl.get("rem_min"),
            "sleep_light_min": sl.get("light_min"),
            "hrv": vi.get("hrv"),
            "rhr": vi.get("rhr"),
            "steps": ac.get("steps"),
            "active_min": ac.get("active_min"),
        }
    return out


def render_health_frontmatter(data: dict) -> str:
    """Render a Health/YYYY-MM-DD.md data file for the health-md-visualizations plugin.

    Uses the plugin's markdown-parser keys (snake_case; sleep stages in hours; required
    top-level `date`). Ultrahuman is preferred per field, falling back to other sources.
    The plugin is Apple-Health-shaped, so body temp / air quality aren't represented here
    (those live in the journal note's Health block instead).
    """
    uh = data.get("ultrahuman") or {}
    us = uh.get("sleep") or {}
    ua = uh.get("activity") or {}
    w, fb, p, sm = (data.get(k) or {} for k in ("withings", "fitbit", "polar", "samsung"))

    fields = {"date": data.get("date")}
    # Activity
    fields["steps"] = first(ua.get("steps"), _sv(fb, "activity", "steps"), _sv(sm, "activity", "steps"))
    fields["active_calories"] = first(_sv(fb, "activity", "calories"), _sv(sm, "activity", "calories"))
    fields["exercise_minutes"] = first(ua.get("active_min"), _sv(fb, "activity", "active_min"))
    fields["vo2_max"] = ua.get("vo2_max")
    # Heart
    fields["resting_heart_rate"] = first(
        us.get("rhr"), _sv(w, "vitals", "rhr"), _sv(fb, "vitals", "rhr"),
        _sv(p, "vitals", "rhr"), _sv(sm, "vitals", "rhr"))
    fields["average_heart_rate"] = _sv(w, "sleep", "hr_avg")
    fields["hrv_ms"] = first(us.get("hrv"), _sv(fb, "vitals", "hrv"), _sv(p, "vitals", "hrv"))
    # Vitals
    fields["blood_oxygen"] = first(us.get("spo2"), _sv(fb, "vitals", "spo2"))
    fields["respiratory_rate"] = first(_sv(fb, "vitals", "breathing_rate"), _sv(p, "vitals", "breathing_rate"))

    # Sleep stages in hours: prefer Ultrahuman (seconds), else first secondary (minutes).
    def sleep_h(uh_sec_key, min_key):
        if us.get(uh_sec_key):
            return _h(sec=us[uh_sec_key])
        for src in (w, fb, p, sm):
            sl = (src or {}).get("sleep") or {}
            if sl.get(min_key):
                return _h(minutes=sl[min_key])
        return None

    fields["sleep_total_hours"] = sleep_h("duration_sec", "duration_min")
    fields["sleep_deep_hours"] = sleep_h("deep_sec", "deep_min")
    fields["sleep_rem_hours"] = sleep_h("rem_sec", "rem_min")
    fields["sleep_core_hours"] = sleep_h("light_sec", "light_min")  # Apple "core" ~= light
    if us.get("time_in_bed_sec") and us.get("duration_sec"):
        fields["sleep_awake_hours"] = _h(sec=max(0, us["time_in_bed_sec"] - us["duration_sec"]))
    else:
        for src in (w, fb, p, sm):
            sl = (src or {}).get("sleep") or {}
            if sl.get("awake_min"):
                fields["sleep_awake_hours"] = _h(minutes=sl["awake_min"])
                break

    lines = ["---", "source: trmnl-health"]
    for k, v in fields.items():
        if v is None or v == "":
            continue
        lines.append(f'{k}: "{v}"' if isinstance(v, str) else f"{k}: {v}")
    # Per-device values (namespaced like ultrahuman_hrv, fitbit_hrv) for the dashboard plugin.
    for dev, metrics in _canonical_per_device(data).items():
        for metric, v in metrics.items():
            if v is None or v == "":
                continue
            lines.append(f"{dev}_{metric}: {v}")
    lines += ["---", "",
              f"<!-- Auto-generated by trmnl-health. Add health-viz code blocks in a dashboard note to chart these. -->",
              ""]
    return "\n".join(lines) + "\n"


def write_health_file(vault: Path, health_folder: str, iso: str, content: str, dry_run: bool) -> str:
    path = vault / health_folder / f"{iso}.md"
    if dry_run:
        return f"[dry-run] would write health data file: {path}\n\n{content}"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return f"wrote health data file: {path}"


def render_block(data: dict) -> str:
    uh = data.get("ultrahuman") or {}
    sleep = uh.get("sleep") or {}
    rec = uh.get("recovery") or {}
    act = uh.get("activity") or {}
    home = uh.get("home") or {}
    trends = data.get("trends") or {}
    arrow = {"up": "▲", "down": "▼", "flat": "−"}

    gen = (data.get("generated_at", "") or "")[:16].replace("T", " ")
    date_str = data.get("date", "")
    src = "Ultrahuman Ring" + (" + Home" if home else "")

    lines = [
        START,
        f"## 🩺 Health — {date_str}",
        f"*auto-synced {gen} · {src}*",
        "",
    ]

    # Human-readable summary lines (only emit a line if we have its data).
    if sleep.get("duration_sec"):
        lines.append(
            f"**Sleep** {fmt_dur(sleep.get('duration_sec'))} · "
            f"score {_disp(sleep.get('score'))} · "
            f"REM {fmt_dur(sleep.get('rem_sec'))} · Deep {fmt_dur(sleep.get('deep_sec'))} · "
            f"HRV {_disp(sleep.get('hrv'))} {arrow.get(trends.get('hrv'), '')} · "
            f"RHR {_disp(sleep.get('rhr'))}"
        )
    body_bits = []
    if rec.get("index") is not None:
        body_bits.append(f"recovery {rec['index']}")
    if sleep.get("spo2") is not None:
        body_bits.append(f"SpO₂ {sleep['spo2']}%")
    if sleep.get("temp_c") is not None:
        body_bits.append(f"temp {sleep['temp_c']}°C")
    if body_bits:
        lines.append("**Body** " + " · ".join(body_bits))
    if act.get("steps") is not None:
        lines.append(
            f"**Activity** {act.get('steps', 0)} steps · {act.get('active_min', 0)}m active · "
            f"movement {_disp(act.get('movement_index'))} · VO₂max {_disp(act.get('vo2_max'))}"
        )
    if home:
        hbits = []
        for label, key, suf in [
            ("AQI", "aqi", ""), ("CO₂", "co2", " ppm"), ("PM2.5", "pm25", ""),
            ("PM10", "pm10", ""), ("VOC", "voc", ""), ("noise", "noise", " dB"),
        ]:
            v = home.get(key)
            if v is not None:
                hbits.append(f"{label} {v}{suf}")
        if home.get("temp_c") is not None:
            hbits.append(f"{home['temp_c']}°C")
        if home.get("humidity") is not None:
            hbits.append(f"{home['humidity']}% RH")
        if hbits:
            lines.append("**Home air** " + " · ".join(hbits))

    # Secondary sources — one summary line each, only if connected/returning data.
    for label, key in SECONDARY:
        src = data.get(key)
        if not src:
            continue
        sl = src.get("sleep") or {}
        ac = src.get("activity") or {}
        vi = src.get("vitals") or {}
        bits = []
        if sl.get("duration_min"):
            bits.append(f"sleep {fmt_min(sl['duration_min'])}")
        if sl.get("score") is not None:
            bits.append(f"score {sl['score']}")
        if ac.get("steps") is not None:
            bits.append(f"{ac['steps']} steps")
        if vi.get("rhr") is not None:
            bits.append(f"RHR {vi['rhr']}")
        if vi.get("hrv") is not None:
            bits.append(f"HRV {vi['hrv']}")
        if vi.get("spo2") is not None:
            bits.append(f"SpO₂ {vi['spo2']}%")
        if bits:
            lines.append(f"**{label}** " + " · ".join(bits))

    # Dataview inline fields (queryable across days). Match the vault's "**Field**:: value" style.
    lines += ["", "%% queryable metrics (Dataview) %%"]

    def field(name, val):
        if val is not None and val != "":
            lines.append(f"- **{name}**:: {val}")

    field("UH-Sleep-Score", sleep.get("score"))
    field("UH-Sleep-Min", sleep.get("duration_min"))
    field("UH-REM-Min", _min(sleep.get("rem_sec")))
    field("UH-Deep-Min", _min(sleep.get("deep_sec")))
    field("UH-HRV", sleep.get("hrv"))
    field("UH-RHR", sleep.get("rhr"))
    field("UH-SpO2", sleep.get("spo2"))
    field("UH-Temp-C", sleep.get("temp_c"))
    field("UH-Recovery", rec.get("index"))
    field("UH-Steps", act.get("steps"))
    field("UH-Active-Min", act.get("active_min"))
    field("UH-Movement", act.get("movement_index"))
    field("UH-VO2Max", act.get("vo2_max"))
    if home:
        field("Home-AQI", home.get("aqi"))
        field("Home-CO2", home.get("co2"))
        field("Home-PM25", home.get("pm25"))
        field("Home-PM10", home.get("pm10"))
        field("Home-VOC", home.get("voc"))
        field("Home-Temp-C", home.get("temp_c"))
        field("Home-Humidity", home.get("humidity"))
        field("Home-Noise-dB", home.get("noise"))

    for label, key in SECONDARY:
        src = data.get(key)
        if not src:
            continue
        sl = src.get("sleep") or {}
        ac = src.get("activity") or {}
        vi = src.get("vitals") or {}
        field(f"{label}-Sleep-Min", sl.get("duration_min"))
        field(f"{label}-Sleep-Score", sl.get("score"))
        field(f"{label}-Deep-Min", sl.get("deep_min"))
        field(f"{label}-REM-Min", sl.get("rem_min"))
        field(f"{label}-Steps", ac.get("steps"))
        field(f"{label}-RHR", vi.get("rhr"))
        field(f"{label}-HRV", vi.get("hrv"))
        field(f"{label}-SpO2", vi.get("spo2"))

    lines.append(END)
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- #
# Upsert into the daily note
# --------------------------------------------------------------------------- #
def insert_after_frontmatter(text: str, block: str) -> str:
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            nl = text.find("\n", end + 1)
            if nl != -1:
                head, tail = text[: nl + 1], text[nl + 1:]
                return f"{head}\n{block}\n{tail}"
    return f"{block}\n{text}"


def upsert(note_path: Path, block: str, template_path: Path | None, dry_run: bool) -> str:
    existing = note_path.read_text(encoding="utf-8") if note_path.exists() else None
    created = existing is None
    if created:
        if template_path and template_path.exists():
            existing = template_path.read_text(encoding="utf-8")
        else:
            existing = ""

    if START in existing and END in existing:
        pre, rest = existing.split(START, 1)
        _, post = rest.split(END, 1)
        new_content = pre + block.rstrip("\n") + post
        action = "updated block"
    else:
        new_content = insert_after_frontmatter(existing, block)
        action = "created note + inserted block" if created else "inserted block"

    if dry_run:
        return f"[dry-run] would {action}: {note_path}\n\n{block}"

    note_path.parent.mkdir(parents=True, exist_ok=True)
    note_path.write_text(new_content, encoding="utf-8")
    return f"{action}: {note_path}"


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def main() -> int:
    ap = argparse.ArgumentParser(description="Export trmnl-health metrics into Obsidian daily notes.")
    ap.add_argument("--config", default=str(Path(__file__).with_name("config.toml")))
    ap.add_argument("--date", help="single day YYYY-MM-DD (default: backfill last N days)")
    ap.add_argument("--days", type=int, help="override backfill_days")
    ap.add_argument("--dry-run", action="store_true", help="print, don't write")
    ap.add_argument("--input", help="local JSON file instead of the Worker (offline testing)")
    ap.add_argument("--vault", help="override vault_path")
    ap.add_argument("--worker", help="override worker_url")
    ap.add_argument("--key", help="override export_key")
    ap.add_argument("--health-folder", help="also write Health/<date>.md data files here (for health-md-visualizations)")
    ap.add_argument("--no-health", action="store_true", help="skip the Health/ data file even if configured")
    ap.add_argument("--health-only", action="store_true", help="only write Health/ data files; skip the daily-note block (good for bulk history backfill)")
    args = ap.parse_args()

    # Ensure unicode (°, ▲, 🩺, …) prints cleanly regardless of console codepage.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )

    cfg = load_config(Path(args.config))
    vault = Path(args.vault or cfg.get("vault_path", "")).expanduser()
    daily_folder = cfg.get("daily_folder", "Notes/Daily Notes")
    daily_format = cfg.get("daily_format", "%y-%m-%d")
    template_rel = cfg.get("template_path")
    template_path = (vault / template_rel) if template_rel else None
    worker = args.worker or cfg.get("worker_url")
    key = args.key or cfg.get("export_key")
    backfill = args.days or int(cfg.get("backfill_days", 3))
    health_folder = "" if args.no_health else (args.health_folder or cfg.get("health_folder", ""))

    if not str(vault):
        log.error("No vault_path set (config or --vault).")
        return 2

    if args.date:
        days = [datetime.strptime(args.date, "%Y-%m-%d").date()]
    else:
        today = date.today()
        days = [today - timedelta(days=i) for i in range(backfill)]

    daily_dir = vault / daily_folder
    rc = 0
    for d in days:
        iso = d.strftime("%Y-%m-%d")
        try:
            if args.input:
                data = json.loads(Path(args.input).read_text(encoding="utf-8"))
            elif worker:
                data = fetch_json(worker, key, iso)
            else:
                log.error("No worker_url and no --input; nothing to fetch.")
                return 2
        except urllib.error.HTTPError as e:
            log.warning("HTTP %s fetching %s (check export_key / worker_url)", e.code, iso)
            rc = 1
            continue
        except Exception as e:  # noqa: BLE001
            log.warning("fetch failed for %s: %s", iso, e)
            rc = 1
            continue

        if isinstance(data, dict) and data.get("error"):
            log.warning("worker error for %s: %s", iso, data["error"])
            rc = 1
            continue

        if not args.health_only:
            block = render_block(data)
            note_path = daily_dir / (d.strftime(daily_format) + ".md")
            log.info(upsert(note_path, block, template_path, args.dry_run))

        if health_folder:
            log.info(write_health_file(vault, health_folder, iso, render_health_frontmatter(data), args.dry_run))

    return rc


if __name__ == "__main__":
    raise SystemExit(main())
