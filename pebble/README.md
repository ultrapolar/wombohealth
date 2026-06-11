# Wombo Health — Pebble watchapp

View the trmnl-health dashboard on a Pebble (including the new
[Core Devices](https://github.com/coredevices) watches — Core 2 Duo / Core Time 2).

The watch shows scrollable cards fed by your deployed Cloudflare Worker:

| Card | Metrics | Shown |
| --- | --- | --- |
| Sleep | score, duration, deep, REM, cycles | always |
| Recovery | recovery score, HRV (+/- trend), RHR, SpO2, skin temp | always |
| Activity | steps, active minutes, movement index, VO2 max | always |
| Air | AQI, CO2, PM2.5, temp, humidity, noise | if Ultrahuman Home is enabled |
| Body | weight, body fat, muscle, water, measured date | if Wyze scale data exists |

**Buttons:** UP/DOWN switch cards · SELECT re-fetches. The footer shows the
Worker's last-updated time and a `(stale)` marker when the ring hasn't synced yet.

## How it works

No Worker changes were needed. The phone-side JS (PebbleKit JS) fetches
`GET /?key=<EXPORT_KEY>` — the same flat, merged, pre-formatted payload TRMNL
polls — and forwards the strings to the watch over AppMessage. All
fallback/stale/merge logic stays in the Worker.

## Setup

1. Build (below) or grab a release `.pbw`, then install it with the
   [Core app](https://play.google.com/store/apps/details?id=coredevices.coreapp)
   / Pebble app, or `pebble install --phone <phone-ip>`.
2. On the phone, open the app's **Settings** (gear icon in the Pebble/Core app)
   and enter:
   - **Worker URL** — `https://<your-worker>.workers.dev`
   - **Export key** — the `EXPORT_KEY` secret you set with `wrangler secret put`
3. Open the app on the watch; it fetches on launch.

## Building

Uses the [Core Devices Pebble SDK](https://github.com/coredevices/pebble-tool):

```bash
# once: install the tool + SDK (Python 3.10–3.13)
uv tool install pebble-tool
pebble sdk install latest

cd pebble
pebble build           # produces build/pebble.pbw for all 7 platforms
```

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

- The export key is stored in the phone app's settings (Clay localStorage),
  never on the watch.
- Steps are comma-grouped on the phone; the HRV trend arrow (▲/▼) is mapped to
  `+`/`-` since the watch system fonts don't include those glyphs.
- Missing metrics render as `--`, matching the TRMNL display.
