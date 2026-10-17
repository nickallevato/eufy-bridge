# eufy-bridge

Gets a Eufy battery doorbell into Shinobi (and so into anything that reads Shinobi,
such as Frigate) as an ordinary RTSP camera, without draining its battery.

The doorbell (model T8214, Wi-Fi direct, no HomeBase) has **no RTSP or local stream of any kind**: the only
open port is Eufy's P2P protocol on UDP 32108. This bridge logs into Eufy with a
second account, opens the P2P livestream **only on events**, and turns that into
one RTSP stream that never stops.

Self-contained: nothing outside this repo is referenced except the runtime paths
below. `<bridge-host>` is the machine running the bridge, `<shinobi-host>` your
Shinobi, `<group>` your Shinobi group key.

## How it works

```
 Eufy cloud ──push: motion / person / ring──┐
                                            v
 doorbell ──P2P livestream (on event)──> bridge.js ──raw H.264, 10 fps, copy──> MediaMTX :8554/doorbell
                                          │  idle: 5 s pre-encoded loop of the last frame,            │
                                          │        dimmed + blurred + "idle - last live HH:MM"         ├─> Shinobi (records, JPEG API)
                                          │  live: P2P video re-encoded, same SPS as the loop          ├─> browsers :8889/doorbell/
                                          └─ control API :8099  /live?s=60  /status                    └─> VLC / ffplay
```

- **One unbroken stream.** Shinobi and Frigate expect a camera that never goes away.
  Between events the bridge replays a placeholder loop. During an event it sends the
  real video. Both are cut on access-unit boundaries, every switch lands on an IDR,
  and one 10 fps clock paces both. The muxer only ever does `-c copy`, and the
  timestamps are constant-rate.
- **The switch is invisible to the decoder.** The idle loop and the live re-encode
  share an identical SPS (800x1100, Main 4.0, no B-frames; checked byte for byte).
  Only GOP and CRF differ, which changes the PPS, and the PPS is resent with every IDR.
- **Battery.** The doorbell streams only for `LIVE_SECONDS` (45) after the last
  event, during a manual `/live`, or while someone watches it through Shinobi. The library's default 30 s livestream cap is
  turned off; the bridge stops the stream itself.

## Measured (Ryzen 5 4600G, 2026-10-16)

| | Value |
|---|---|
| Idle CPU | ~0.2% of one core (replaying the loop; it is encoded once per event, ~5 s CPU) |
| Live CPU | ~21-26% of one core, only during events |
| Idle on the wire / on Shinobi's disk | 28 kbps, ~0.3 GB/day (was ~4.3 GB/day before the cheap idle loop) |
| Live | ~1.4 Mbps, ~8 MB per 45 s event |
| Event -> live picture | Eufy push arrives 1-10 s after the person (vs Frigate on a neighbouring camera), then ~1.5 s to picture (P2P start ~1 s + encoder ~0.5 s; was ~5.5 s before 2026-10-16) |
| Shinobi | records with `-c copy`, 0.2% CPU; 15-min files match the source exactly (H.264 Main 4.0, 800x1100, 10/1 CFR, duration = wall clock, 0 decode errors) |

## Layout

| Path | What |
|---|---|
| `bridge.js` | the bridge |
| `mediamtx.yml` | RTSP/WebRTC server config |
| `bin/run-bridge`, `bin/run-mediamtx` | launchers |
| `shinobi/doorbell_monitor.py` | create/check/remove the Shinobi monitor; runs on the Shinobi host |
| `tools/probe-account.js` | read-only: what the Eufy account sees (invites, devices, battery) |

Runtime paths, all outside the repo:

| Path | What |
|---|---|
| `~/.config/eufy-bridge/env` (0600) | `EUFY_USER=` / `EUFY_PASS=` of the **second** Eufy account |
| `~/.local/state/eufy-bridge/` (0700) | Eufy session tokens (`persistent.json`), `last.jpg`, the idle loop, logs |
| `~/.local/opt/mediamtx/mediamtx` | MediaMTX v1.15.3 binary (download command in `bin/run-mediamtx`) |

## Setup

1. **Eufy account.** Create a second Eufy account. In the main account's app, share
   the doorbell to it. The bridge accepts the invite on its own. Do not use the
   main account: the bridge's login would keep signing the phone out.
2. **Credentials** in `~/.config/eufy-bridge/env`, mode 0600.
3. **Install:** `npm ci`, plus the MediaMTX binary. Needs `ffmpeg` with libx264
   and the DejaVu Sans Bold font.
4. **Run** `bin/run-mediamtx` and `bin/run-bridge`. On a first login Eufy may email
   a code: write it to `~/.local/state/eufy-bridge/tfa-code`, and the bridge picks
   it up.
5. **Shinobi:** run `shinobi/doorbell_monitor.py` as root on the Shinobi host, for
   example with Ansible. It clones an existing plain RTSP monitor as the template:
   ```bash
   ansible shinobi -b -m ansible.builtin.script \
     -a "shinobi/doorbell_monitor.py --group <group> --template <monitor-id> apply rtsp://<bridge-host>:8554/doorbell"
   ```

## Operating

```bash
curl -s http://<bridge-host>:8099/status         # mode, live sessions, underflows, last event
curl -s "http://<bridge-host>:8099/live?s=60"    # go live now for 60 s
tail -f ~/.local/state/eufy-bridge/bridge.log
npm run probe                                    # (with the env loaded) devices + battery
```

- Watch in a browser: `http://<bridge-host>:8889/doorbell/`
- RTSP: `rtsp://<bridge-host>:8554/doorbell`
- Shinobi camera id **`doorbell`**. JPEG:
  `https://<shinobi-host>/<apiKey>/jpeg/<group>/doorbell/s.jpg`.
  It is portrait, 800x1100, two views stacked (street on top, package camera
  below), and shows the idle placeholder except during events.
- When the bridge restarts, Shinobi loses the stream and reconnects by itself in
  ~13 s.

## Live on demand: a viewer opening the stream

nginx on the Shinobi host mirrors every request for the doorbell's **video**
streams to `/live?reason=viewer`, using nginx's `mirror` directive on the Shinobi
vhost (it lives in your infra config, not here). So a client
that shows the JPEG and switches to the stream when the user taps "live" wakes the
doorbell with no change on its side:

| Request | Effect |
|---|---|
| `/<key>/jpeg/<group>/doorbell/s.jpg` | nothing (stays cheap) |
| `/<key>/hls/<group>/doorbell/s.m3u8`, `/embed/...` | +60 s per request; HLS re-polls every few seconds, so live lasts while someone watches and ends 60 s after the last poll |
| `/<key>/mp4|flv|h265|mjpeg/...` | +300 s once (one long request). Shinobi answers 503 "MP4 Stream is not enabled" for these: every monitor here streams HLS |

Measured 2026-10-16: first HLS request -> live picture 1.3 s; last poll -> back to
idle 60 s. The first segments a viewer gets are still the idle loop (Shinobi's HLS
lags a few seconds). The mirror fires before Shinobi checks the API key, so any
request on that path wakes the doorbell. Keep nginx LAN-only.

## Traps found on the way

- **Shinobi stores `snap: "1"` as the number `1`** when saved through
  `configureMonitor`, but only builds the JPEG output for the string `'1'`. A cloned
  monitor therefore had no JPEG API. `doorbell_monitor.py apply` sets it in the DB
  and cycles the monitor stop -> record, which reloads from the DB.
- **The read-only Shinobi agent keys cache their camera list** until
  `pm2 restart camera` (~40 s gap on every camera). The doorbell is invisible to
  those keys until then; full-access keys see it at once.
- **Eufy device type 94 / T8214 is dual-camera**: one 1600x2200 picture, two views
  stacked. Its stream resolution changes on its own (seen 1024x1408); the live
  re-encode scales everything to 800x1100, so consumers never see that.
- **Writing raw H.264 with wallclock timestamps into the muxer** gave
  non-monotonic DTS, because the live encoder emits in bursts. Hence the single
  10 fps clock with a 5-AU prebuffer.
- **x264's default threading and lookahead held ~3 s of frames** before the live
  encoder emitted anything, and ffmpeg's input probe ~1 s more. The live encoder
  runs `-threads 2`, `rc-lookahead=0` and no probe. `-tune zerolatency` would be
  faster still, but it changes one SPS bit and breaks the matching SPS.
- **Eufy's account share also brought the account's other cameras (T8441,
  T8442).** The bridge ignores them; set `EUFY_DEVICE_SN` to pick another device.

## Open

- Plain background processes: **not restarted after a reboot** (no unit yet). If
  the bridge host restarts, the doorbell is dead in Shinobi until someone runs the
  two launchers.
- Event-triggered live has only been driven by `/live` so far; a real
  motion/ring trigger has not been watched end to end.
- Not in Frigate yet. **Do not feed Frigate the
  doorbell from Shinobi's HLS** like the other cameras: Frigate polls forever, the
  viewer hook would keep the doorbell streaming 24/7. Point it at
  `rtsp://<bridge-host>:8554/doorbell` instead.
- Untested: passing the doorbell's H.264 straight through (zero CPU), which would
  need an idle loop that matches the doorbell's own SPS, while that resolution
  changes on its own.
- No audio, and no ring events in Home Assistant.
