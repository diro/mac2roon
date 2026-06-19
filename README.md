# mac2roon

Stream **all Mac audio (primarily Apple Music)** into a **Roon zone** as a native
Roon source, at **lossless** quality, with **now-playing metadata** and **zone
selection**.

It captures the Mac's audio from a virtual loopback device, encodes it to a live
**lossless FLAC** HTTP stream, and injects that into Roon through Roon's official
**audio-input** extension API (`com.roonlabs.audioinput:1`). Apple Music
title/artist/album are bridged separately via AppleScript and pushed to Roon's
now-playing.

```
 Apple Music / any app
        │  (CoreAudio, system output = BlackHole)
        ▼
   BlackHole 2ch ──► sox (CoreAudio capture, gapless) ──► ffmpeg (FLAC/Ogg, no resample)
                                                                │
                                                  HTTP  http://<mac-lan-ip>:4747/stream.ogg
                                                                │  Roon pulls this
                                                                ▼
   Music.app ──AppleScript──► mac2roon ──node-roon-api-audioinput──► Roon zone (RAAT)
   (title/artist/album,          │  begin_session / play / update_track_info
    play state)                  └─ now-playing text updates per track, gaplessly
```

## Status (verified on real hardware)

Works:
- **Lossless audio** into the Roon zone, gapless. Verified bit-exact duration (no dropped samples).
- **Now-playing** title/artist/album, updating per track **without interrupting audio**.
- **Zone selection** via Roon's native zone picker (extension Settings).
- Auto start/stop with Apple Music playback (Follow mode); resume by pressing play in Apple Music.

Known limitations (Roon platform behavior — not fixable from this side):
- **No per-track album art in Roon.** We send `image_url` (local artwork or an iTunes cover URL) but Roon does not fetch/render artwork for audioinput sources. Only the source's brand icon shows.
- **Roon transport is stop-only.** A live/infinite stream is treated like internet radio, so Roon offers only **Stop** (no pause/skip/seek). Pressing Stop ends the session and Roon reverts to its own queue. **Control playback from Apple Music instead** — play/pause/next there, and Roon's now-playing follows. To return to the Mac source after a Stop, press play in Apple Music (Follow mode re-takes the zone).

## Why sox (not ffmpeg) for capture

ffmpeg's `avfoundation` audio input **drops ~10–13% of samples** (measured: 20 s of
wall time yielded only 17.6 s of audio), which is constant crackling. **sox**
captures CoreAudio gaplessly (20 s → 20.000 s). So sox captures; ffmpeg only
encodes.

## Requirements

- macOS, **Node ≥ 20** (tested on 25).
- **ffmpeg + ffprobe**, **sox**: `brew install ffmpeg sox`
- **BlackHole 2ch** (free virtual audio device): `brew install blackhole-2ch`, then reboot.
- *(optional)* **switchaudio-osx** to set the output device from the CLI: `brew install switchaudio-osx`
- A **Roon Core** on the same LAN with at least one zone.

## Setup

```sh
npm install                       # Roon API deps (from GitHub)
```

1. **Route audio to BlackHole.** Set the Mac's system output to **BlackHole 2ch**
   (System Settings → Sound → Output, or `SwitchAudioSource -s "BlackHole 2ch"`).
   The Mac goes silent locally — the audio comes out of the **Roon zone**, which is
   the point. (To also hear it locally, build a Multi-Output Device in Audio MIDI
   Setup, at some cost to bit-perfect — see Bit-perfect below.)
2. **Grant Automation permission.** Run `npm start` once from a terminal and click
   **Allow** on the macOS prompt to let it control Music.app (needed for now-playing).
3. **Enable in Roon** → Settings → Extensions → **Mac → Roon (Apple Music Bridge)**
   → Enable → **Settings**: pick **Zone**, **Capture device** = `BlackHole 2ch`,
   **Stream mode** = Follow Apple Music, **Artwork** = On.
4. Play something in Apple Music. The source appears in the chosen zone.

### Run as a background service

After granting the Automation prompt once interactively:

```sh
ITUNES_COUNTRY=TW ./scripts/install-service.sh   # LaunchAgent, auto-starts at login
launchctl list | grep mac2roon
tail -f /tmp/mac2roon.out /tmp/mac2roon.err
./scripts/uninstall-service.sh
```

Note: macOS Automation (controlling Music.app) is per-responsible-process. If
now-playing stops working under the LaunchAgent, run `npm start` from a terminal
once more to (re)grant it, or run the bridge from a login shell.

## Bit-perfect / sample rate

**sox captures at the device's native rate and we never resample**, so
bit-perfect is controlled at the **device**: macOS Music.app does
not auto-switch rate, so set BlackHole's rate in **Audio MIDI Setup** (or use
**LosslessSwitcher**) to match the track. The live capture rate is logged each
time Roon opens the stream (`capture rate: NNNNN Hz`) so you can confirm. Mac
built-in DACs cap at 96 kHz; the Roon endpoint's DAC is what actually plays.

You are tapping decoded system audio (Apple Music is FairPlay-DRM'd; no clean
stream is exposed), so quality equals the decoded output — perfect for ≤24-bit.

## Configuration

User settings (Zone / Capture device / Stream mode / Artwork) live in Roon's
extension Settings and persist to `./config.json`. Env vars:

| Env | Default | Purpose |
|-----|---------|---------|
| `PORT` | `4747` | HTTP stream port |
| `ADVERTISE_HOST` | auto LAN IP | host in the URL handed to Roon (override if autodetect is wrong) |
| `CONTAINER` | `ogg` | `ogg` (Ogg-FLAC) or `flac` |
| `ITUNES_COUNTRY` | `US` | iTunes storefront for the artwork fallback (e.g. `TW`) |
| `POLL_MS` | `1500` | Music.app metadata poll interval |
| `SOX` / `FFMPEG` | `sox`/`ffmpeg` | binary paths |
| `LOG_LEVEL` | `info` | `debug` shows the Roon protocol trace + all messages |

## Verify the audio path without Roon

```sh
npm run devices            # list capture devices
npm run test:audio "BlackHole 2ch" 15   # capture 15s, prove drop-free lossless FLAC over HTTP
```

## Troubleshooting

- **Crackling:** ensure capture uses sox (this version does). Confirm with `npm run test:audio` — audio duration must equal the requested seconds.
- **No now-playing / metadata:** grant Automation for Music.app (Privacy & Security → Automation); under a LaunchAgent you may need to grant from a terminal run.
- **“Please configure zone / device”:** set both in the extension Settings.
- **Silent zone:** confirm BlackHole is the system output and something is playing in Apple Music.
- **Stream won’t start:** try `CONTAINER=flac npm start`.
- **Wrong artwork or none:** Roon doesn’t render artwork for audioinput sources (known); the iTunes match may also miss for obscure/classical titles. Set `ITUNES_COUNTRY` to your region.
- **Pressed Stop in Roon and it switched to another album:** expected — Roon reverts a stopped live source to its own queue. Press play in Apple Music to return to the Mac source.

## If the trade-offs don’t suit you

For true Roon-native transport + per-track art + hi-res, run **Qobuz/TIDAL inside
Roon** (different catalog). For the easiest “keep Apple Music” path with native
phone/Mac transport, use **AirPlay 2** directly (≈CD quality, Roon not the
controller). This project exists for when **Apple Music specifically, inside a Roon
zone, losslessly** is the goal.
