# Wombo Health — Pebble watchapp

Your trmnl-health dashboard as a clone of PebbleOS's built-in **Health** app —
same card UI, same navigation, same slide-with-overshoot animations — but fed by
your Cloudflare Worker (Ultrahuman / Withings / Fitbit / Polar / Wyze) instead
of the watch's accelerometer. Built for the
[Core Devices](https://github.com/coredevices) revival (Core 2 Duo / Core Time 2)
and original Pebbles.

## Taking over the UP button

On Core Devices firmware, a single UP press from the watchface is a
configurable quick-launch slot (it just defaults to the built-in Health app).
To make it open Wombo Health instead:

> On the watch: **Settings → Quick Launch → Tap Up → Wombo Health**

Then UP from the watchface drops you straight into your cards, and DOWN from
the first card slides you back to the watchface — exactly like the system app.

## Cards

| Card | Shows | Visible |
| --- | --- | --- |
| Activity | progress ring (today vs. step goal) with a yellow "typical" week-average marker, footprint icon, count-up step total | always |
| Heart | beating heart (lub-dub), resting BPM, HRV box with trend arrow | always |
| Sleep | crescent moon, time asleep as H:MM, sleep score box | always |
| Air | cloud, AQI, CO2 box | if Ultrahuman Home is enabled |
| Body | scale icon, weight, body-fat box | if Wyze scale data exists |

**Controls** (mirrors the system Health app):
- **UP / DOWN** — slide between cards (with the moook-style overshoot bounce);
  DOWN below the first card exits to the watchface
- **SELECT** — detail view for the current card (all metrics as rows)
- **long SELECT** — re-fetch from the Worker

Numbers count up and the ring sweeps in when fresh data lands. The last
payload is persisted on the watch, so launching shows data instantly (a
`stale` tag appears top-right when the Worker says the ring hasn't synced).

## How it works

No Worker changes needed. The phone-side JS (PebbleKit JS) fetches
`GET /?key=<EXPORT_KEY>` — the same flat, merged payload TRMNL polls — and
forwards it over AppMessage. The weekly `zone_1..7` bars (each day's % of step
goal) drive the activity ring: today's bar is the green fill, the average of
the other days is the yellow "typical" marker.

## Setup

1. Build (below) or grab a release `.pbw`, then install it with the
   [Core app](https://play.google.com/store/apps/details?id=coredevices.coreapp)
   / Pebble app, or `pebble install --phone <phone-ip>`.
2. On the phone, open the app's **Settings** (gear icon in the Pebble/Core app)
   and enter:
   - **Worker URL** — `https://<your-worker>.workers.dev`
   - **Export key** — the `EXPORT_KEY` secret you set with `wrangler secret put`
3. Open the app on the watch (or set up Tap Up, above).

## Building

Uses the [Core Devices Pebble SDK](https://github.com/coredevices/pebble-tool):

```bash
# once: install the tool + SDK (Python 3.10–3.13)
uv tool install pebble-tool
pebble sdk install latest

cd pebble
pebble build           # produces build/pebble.pbw
```

With the official SDK (4.4+ from `sdk.repebble.com`) the build also emits
native `flint`/`gabbro` (Core 2 Duo / Core Time 2) binaries. The Core 2 Duo
also happily runs the `diorite` build (same display), so a 5-platform `.pbw`
still installs and works on it.

### Building with a modern arm-none-eabi-gcc

If you use your distro's toolchain (e.g. `apt install gcc-arm-none-eabi`)
instead of the SDK-bundled one, the `wscript` here already carries the needed
workarounds (`-Wno-builtin-macro-redefined`, `-Wno-builtin-declaration-mismatch`,
`-include sys/types.h`) — the SDK headers predate GCC 9+.

If the SDK download server is unreachable, the SDK core can also be installed
straight from GitHub: clone [coredevices/sdk-core](https://github.com/coredevices/sdk-core)
into `~/.pebble-sdk/SDKs/4.4/sdk-core`, create a venv at
`~/.pebble-sdk/SDKs/4.4/.venv` with its `requirements.txt`, symlink your
`arm-none-eabi-*` binaries into `~/.pebble-sdk/SDKs/4.4/toolchain/arm-none-eabi/bin/`,
then `pebble sdk activate 4.4`.

## Notes

- The card design, colors (green-on-black activity, OxfordBlue sleep, white
  heart card), slide behavior, and detail-view pattern follow the open-source
  PebbleOS Health app
  ([coredevices/PebbleOS](https://github.com/coredevices/PebbleOS),
  `src/fw/apps/system/health/`, Apache-2.0). The overshoot slide curve
  approximates the firmware's internal `interpolate_moook_soft`, which isn't
  exposed by the public SDK.
- The export key is stored in the phone app's settings (Clay localStorage),
  never on the watch.
- Missing metrics render as `--`, matching the TRMNL display.
