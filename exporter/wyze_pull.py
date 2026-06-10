#!/usr/bin/env python3
"""Local Wyze smart-scale puller for trmnl-health.

Wyze has no official API, so this uses the reverse-engineered `wyze-sdk` to read
body-composition weigh-ins and POST them to the Worker's /ingest/wyze endpoint,
from where they flow into BOTH the TRMNL display and the Obsidian export.

Weigh-ins are sparse and ingest is idempotent (keyed by weigh-in date), so run it
on a relaxed schedule (e.g. daily). The Worker carries the latest weigh-in forward
to fill gap days.

One-time setup
--------------
  pip install wyze-sdk
  Generate an API key + Key Id at https://developer-api-console.wyze.com (same Wyze
  account), then add a [wyze] section to exporter/config.toml (see config.toml.example).

  IMPORTANT: scripted login only works if the Wyze account's 2FA is an AUTHENTICATOR
  APP (TOTP) — provide its secret as totp_key. Accounts on SMS/email MFA cannot be
  automated by wyze-sdk; switch to an authenticator app (or disable 2FA) first.

Usage
-----
  python wyze_pull.py --debug      # print one record's raw SDK attributes, then exit
                                   # (use this ONCE to confirm units: %, kg, kcal, …)
  python wyze_pull.py --dry-run    # show what would be posted; post nothing
  python wyze_pull.py              # pull recent weigh-ins and push to the Worker

Field mapping (verified against the wyze-sdk ScaleRecord source — note the names
are NOT the obvious ones):
  weight_kg      <- record._weight (raw kg; .weight defaults to LB!)
  bmi            <- record.bmi
  body_fat_pct   <- record.body_fat            (NOT body_fat_percentage)
  muscle_mass_kg <- record.muscle              (NO lean_body_mass field exists)
  body_water_pct <- record.body_water
  bmr_kcal       <- record.bmr                 (NOT basal_metabolism)
  visceral_fat   <- record.body_vfr            (visceral-fat rating; NOT visceral_fat)
  bone_mass_kg   <- record.bone_mineral        (NOT bone_mass)
  metabolic_age  <- record.metabolic_age
  protein_pct    <- record.protein
  (there is NO heart_rate field on ScaleRecord)
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover
    tomllib = None

log = logging.getLogger("wyze")
TOKEN_FILE = Path(__file__).with_name(".wyze_token.json")

# our normalized key -> ScaleRecord attribute (verified SDK names)
BODY_ATTRS = {
    "bmi": "bmi",
    "body_fat_pct": "body_fat",
    "muscle_mass_kg": "muscle",
    "body_water_pct": "body_water",
    "bmr_kcal": "bmr",
    "visceral_fat": "body_vfr",
    "bone_mass_kg": "bone_mineral",
    "metabolic_age": "metabolic_age",
    "protein_pct": "protein",
}


def load_cfg(path: str) -> dict:
    p = Path(path)
    if p.exists() and tomllib:
        with p.open("rb") as f:
            return tomllib.load(f)
    return {}


def num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f else None  # drop NaN


def record_to_body(rec) -> dict:
    body = {}
    kg = getattr(rec, "_weight", None)
    if kg is None:
        kg = getattr(rec, "weight", None)  # may be lb depending on SDK version/default
    kg = num(kg)
    if kg is not None:
        body["weight_kg"] = round(kg, 2)
        body["weight_lb"] = round(kg * 2.20462262185, 2)
    for our_key, attr in BODY_ATTRS.items():
        v = num(getattr(rec, attr, None))
        if v is not None:
            body[our_key] = v
    return body


def local_date(epoch_s: int, tz_offset_hours: float) -> str:
    dt = datetime.fromtimestamp(epoch_s, tz=timezone.utc) + timedelta(hours=tz_offset_hours)
    return dt.strftime("%Y-%m-%d")


def post(worker: str, key: str, date: str, body: dict, measured_at: int) -> int:
    url = f"{worker.rstrip('/')}/ingest/wyze?date={date}"
    data = json.dumps({"date": date, "measured_at": measured_at, "body": body}).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json", "X-Export-Key": key or ""},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status


def get_client(w: dict):
    from wyze_sdk import Client  # imported lazily so the module loads without the dep

    # Reuse cached tokens when possible — /login is rate-limited, so don't hit it every run.
    if TOKEN_FILE.exists():
        try:
            tok = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
            if tok.get("access_token"):
                return Client(token=tok["access_token"], refresh_token=tok.get("refresh_token"))
        except Exception as e:  # noqa: BLE001
            log.info("cached Wyze token unusable (%s); logging in fresh", e)

    client = Client()
    kwargs = {"email": w["email"], "password": w["password"], "key_id": w["key_id"], "api_key": w["api_key"]}
    if w.get("totp_key"):
        kwargs["totp_key"] = w["totp_key"]
    client.login(**kwargs)
    try:
        TOKEN_FILE.write_text(json.dumps({
            "access_token": getattr(client, "_token", None),
            "refresh_token": getattr(client, "_refresh_token", None),
        }), encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    return client


def get_records(client, w: dict, days: int):
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    model = w.get("device_model")
    try:
        if model:
            return client.scales.get_records(device_model=model, start_time=start, end_time=end)
        return client.scales.get_records(start_time=start, end_time=end)
    except TypeError:
        # older/newer signatures: fall back to the simplest form
        return client.scales.get_records(start_time=start, end_time=end)


def main() -> int:
    ap = argparse.ArgumentParser(description="Pull Wyze scale weigh-ins and push them to the trmnl-health Worker.")
    ap.add_argument("--config", default=str(Path(__file__).with_name("config.toml")))
    ap.add_argument("--days", type=int, default=14, help="how many days back to fetch (default 14)")
    ap.add_argument("--dry-run", action="store_true", help="print what would be posted; post nothing")
    ap.add_argument("--debug", action="store_true", help="dump one record's raw SDK attributes and exit")
    ap.add_argument("--worker")
    ap.add_argument("--key")
    args = ap.parse_args()

    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
                        handlers=[logging.StreamHandler(sys.stdout)])

    cfg = load_cfg(args.config)
    w = cfg.get("wyze", {})
    worker = args.worker or cfg.get("worker_url")
    key = args.key or cfg.get("export_key")
    tz_offset = float(w.get("tz_offset", 0))

    for req in ("email", "password", "key_id", "api_key"):
        if not w.get(req):
            log.error("missing [wyze] %s in %s", req, args.config)
            return 2
    if not args.dry_run and not args.debug and not worker:
        log.error("no worker_url configured")
        return 2

    try:
        client = get_client(w)
        records = list(get_records(client, w, args.days) or [])
    except Exception as e:  # noqa: BLE001
        log.error("Wyze fetch failed: %s", e)
        return 1

    if not records:
        log.warning("no weigh-ins in the last %d days (if you have a newer scale, set [wyze] device_model)", args.days)
        return 0

    if args.debug:
        rec = records[-1]
        attrs = {k: str(getattr(rec, k)) for k in dir(rec)
                 if not k.startswith("__") and not callable(getattr(rec, k, None))}
        log.info("most recent record's raw attributes (verify units once):\n%s", json.dumps(attrs, indent=2))
        return 0

    rc = 0
    for rec in records:
        ts = num(getattr(rec, "measure_ts", None))
        if ts is None:
            continue
        ts = int(ts)
        date = local_date(ts, tz_offset)
        body = record_to_body(rec)
        if not body:
            continue
        if args.dry_run:
            log.info("[dry-run] %s -> %s", date, body)
            continue
        try:
            post(worker, key, date, body, ts)
            log.info("pushed %s (%d metrics)", date, len(body))
        except Exception as e:  # noqa: BLE001
            log.warning("post failed for %s: %s", date, e)
            rc = 1
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
