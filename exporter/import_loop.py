#!/usr/bin/env python3
"""Backfill healthy habits from a Loop Habit Tracker (uhabits) CSV export.

Loop (org.isoron.uhabits) has no automation API for *reading* checkmarks — its
Tasker integration is write-only — but its "Export as CSV" produces a ZIP this
script can mine. Each day's habits are POSTed to the Worker's /ingest/habits
(merge semantics, server-side sanitization); the regular exporter then writes
habit_<name> frontmatter into Health/<date>.md, where the dashboard plugin's
Habits tab and Dataview pick them up.

ZIP layout (verified against uhabits source, HabitsCSVExporter.kt @ dev):
  Habits.csv                        Position,Name,Type(YES_NO|NUMERICAL),...,Unit,...
  NNN <Habit Name>/Checkmarks.csv   Date,Value,Notes   (Date = YYYY-MM-DD)
  Checkmarks.csv, Scores.csv        combined files (unquoted header names; ignored)

Checkmark values (uhabits Entry.kt):
  YES_MANUAL (2) -> 1 (did it)        NO (0)        -> 0 (didn't, was expected)
  YES_AUTO   (1) -> 0 (not expected   SKIP (3)      -> omitted (day not applicable)
                      that day, no    UNKNOWN (-1)  -> omitted (no data)
                      action taken)
NUMERICAL habits store amount*1000 in the entry value; we divide it back out, so
"Walk (min)" with 25000 becomes habit_walk: 25.

Usage:
  python import_loop.py "Loop Habits CSV 2026-06-12.zip"          # worker/key from config.toml
  python import_loop.py backup.zip --since 2026-03-01 --dry-run
  python import_loop.py --selftest

No third-party dependencies (stdlib: zipfile, csv, urllib, tomllib).
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover
    tomllib = None

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
CHECKMARKS_RE = re.compile(r"^(\d{3}) .*/Checkmarks\.csv$")


def slugify(name: str) -> str:
    """Match the Worker's habit-name slug so dry-run output equals what lands in KV."""
    s = re.sub(r"[^a-z0-9_]", "", str(name).strip().lower().replace(" ", "_"))[:40]
    return s if re.match(r"^[a-z]", s) else ""


def parse_habits_csv(text: str) -> dict[int, dict]:
    """Habits.csv -> {position: {"name", "numerical"}}."""
    out = {}
    for row in csv.DictReader(io.StringIO(text)):
        try:
            pos = int(row.get("Position", ""))
        except ValueError:
            continue
        out[pos] = {
            "name": (row.get("Name") or "").strip(),
            "numerical": (row.get("Type") or "").strip().upper() == "NUMERICAL",
        }
    return out


def checkmark_value(raw: str, numerical: bool) -> float | int | None:
    """One Checkmarks.csv Value cell -> habit value, or None to omit the day."""
    raw = (raw or "").strip()
    if numerical:
        # Entry sentinels still render as words when the stored int collides
        # with them (formattedValue matches on the raw int), so handle both.
        if raw == "NO":
            return 0
        if re.fullmatch(r"-?\d+", raw):
            n = int(raw)
            if n < 0:
                return None
            return n // 1000 if n % 1000 == 0 else n / 1000
        return None
    return {"YES_MANUAL": 1, "NO": 0, "YES_AUTO": 0}.get(raw)


def parse_archive(src) -> dict[str, dict[str, float | int]]:
    """Loop export ZIP (path or file-like) -> {YYYY-MM-DD: {slug: value}}."""
    days: dict[str, dict] = {}
    with zipfile.ZipFile(src) as zf:
        habits = parse_habits_csv(zf.read("Habits.csv").decode("utf-8"))
        for entry in zf.namelist():
            m = CHECKMARKS_RE.match(entry)
            if not m:
                continue
            habit = habits.get(int(m.group(1)))
            slug = slugify(habit["name"]) if habit else ""
            if not slug:
                continue
            for row in csv.DictReader(io.StringIO(zf.read(entry).decode("utf-8"))):
                date = (row.get("Date") or "").strip()
                if not DATE_RE.match(date):
                    continue
                v = checkmark_value(row.get("Value", ""), habit["numerical"])
                if v is not None:
                    days.setdefault(date, {})[slug] = v
    return days


def post_days(worker: str, key: str, days: dict, dry_run: bool) -> int:
    failures = 0
    for date in sorted(days):
        body = {"date": date, "habits": days[date]}
        if dry_run:
            print(f"would POST {json.dumps(body)}")
            continue
        req = urllib.request.Request(
            worker.rstrip("/") + "/ingest/habits",
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json", "X-Export-Key": key},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp.read()
            print(f"{date}: ok ({len(days[date])} habit(s))")
        except urllib.error.URLError as e:
            failures += 1
            print(f"{date}: FAILED ({e})", file=sys.stderr)
    return failures


def load_config(path: Path) -> dict:
    if not path.exists() or tomllib is None:
        return {}
    with open(path, "rb") as fh:
        return tomllib.load(fh)


def selftest() -> None:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("Habits.csv", (
            "Position,Name,Type,Question,Description,FrequencyNumerator,"
            "FrequencyDenominator,Color,Unit,Target Type,Target Value,Archived?\n"
            '001,Meditation,YES_NO,,,1,1,#FFFFFF,,,0.0,0\n'
            '002,"Walk, intentional",NUMERICAL,,,1,1,#FFFFFF,min,AT_LEAST,20.0,0\n'
        ))
        zf.writestr("001 Meditation/Checkmarks.csv", (
            "Date,Value,Notes\n2026-06-10,YES_MANUAL,\n2026-06-09,NO,\n"
            "2026-06-08,SKIP,\n2026-06-07,YES_AUTO,\n2026-06-06,UNKNOWN,\n"
        ))
        zf.writestr("002 Walk intentional/Checkmarks.csv", (
            "Date,Value,Notes\n2026-06-10,25000,\n2026-06-09,NO,\n2026-06-08,1500,\n"
        ))
        zf.writestr("Checkmarks.csv", "Date,Meditation,\n")  # combined file is ignored
    buf.seek(0)
    days = parse_archive(buf)
    assert days["2026-06-10"] == {"meditation": 1, "walk_intentional": 25}, days
    assert days["2026-06-09"] == {"meditation": 0, "walk_intentional": 0}, days
    assert days["2026-06-08"] == {"walk_intentional": 1.5}, days  # meditation SKIP omitted
    assert days["2026-06-07"] == {"meditation": 0}, days  # YES_AUTO -> not done that day
    assert "2026-06-06" not in days, days  # UNKNOWN-only day omitted entirely
    print("PASS: Loop CSV import OK")


def main() -> int:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("archive", nargs="?", help="Loop 'Export as CSV' ZIP file")
    ap.add_argument("--worker", help="Worker base URL (default: config.toml worker_url)")
    ap.add_argument("--key", help="export key (default: config.toml export_key)")
    ap.add_argument("--since", help="only import days on/after YYYY-MM-DD")
    ap.add_argument("--dry-run", action="store_true", help="print payloads, don't POST")
    ap.add_argument("--config", default=str(here / "config.toml"))
    ap.add_argument("--selftest", action="store_true", help="run built-in tests and exit")
    args = ap.parse_args()

    if args.selftest:
        selftest()
        return 0
    if not args.archive:
        ap.error("archive is required (or use --selftest)")
    if args.since and not DATE_RE.match(args.since):
        ap.error("--since must be YYYY-MM-DD")

    cfg = load_config(Path(args.config))
    worker = args.worker or cfg.get("worker_url") or ""
    key = args.key or cfg.get("export_key") or ""
    if not args.dry_run and (not worker or not key):
        ap.error("need --worker and --key (or worker_url/export_key in config.toml)")

    days = parse_archive(args.archive)
    if args.since:
        days = {d: h for d, h in days.items() if d >= args.since}
    if not days:
        print("nothing to import (no checkmarks in range)")
        return 0
    print(f"importing {len(days)} day(s), {sum(len(h) for h in days.values())} checkmark(s)")
    return 1 if post_days(worker, key, days, args.dry_run) else 0


if __name__ == "__main__":
    sys.exit(main())
