# mac2roon — Installation Guide (from scratch)

Stream Apple Music from your Mac into a **Roon zone**, **losslessly**. This walks
you from a clean Mac to a working setup, then covers optional **bit-perfect** and
**background autostart**.

---

## 0. Prerequisites

- A **macOS** machine (Apple Silicon or Intel).
- A **Roon Core** on the same LAN with at least one playable zone (any RAAT / Roon Ready / AirPlay / Squeezebox endpoint).
- **Homebrew** installed (if not, see https://brew.sh).

---

## 1. Install the tools

```sh
# Required: encoder, gapless capture tool, output switcher
brew install ffmpeg sox switchaudio-osx
brew install blackhole-2ch        # virtual loopback audio device (signed driver)
brew install node                 # if you don't have Node yet (needs >= 20)
```

> **Reboot (or log out/in) after installing BlackHole** so the driver loads fully.

---

## 2. Get the code and install dependencies

```sh
git clone https://github.com/diro/mac2roon.git
cd mac2roon
npm install                       # Roon API packages (from GitHub)
```

Confirm the capture device is visible:

```sh
npm run devices
# Should list [n] BlackHole 2ch and suggest it as the default
```

---

## 3. Route system audio into BlackHole

Set the Mac's **system output** to **BlackHole 2ch**:

```sh
SwitchAudioSource -s "BlackHole 2ch"
# or: System Settings → Sound → Output → BlackHole 2ch
```

> Your Mac going silent locally is **expected** — the audio comes out of your
> **Roon zone's** speakers, which is the point.
> (To also hear it on the Mac, build a Multi-Output Device in Audio MIDI Setup
> combining your real output + BlackHole — at some cost to bit-perfect.)

---

## 4. Verify the audio path (optional but recommended)

Start a track in Apple Music, then:

```sh
npm run test:audio "BlackHole 2ch" 15
# PASS = lossless FLAC captured at NNNNN Hz, with captured duration = 15 s (no dropped samples)
```

---

## 5. First run + permission

Run it once from a **terminal** so macOS can show the permission prompt:

```sh
npm start
```

macOS will ask to control "Music" — click **Allow** (needed to read now-playing).
When the log shows `Discovery started`, it's waiting to pair with Roon.

---

## 6. Enable and configure in Roon

1. Roon → **Settings → Extensions**
2. Find **"Mac → Roon (Apple Music Bridge)"** and click **Enable**
3. Click its **Settings** and set:
   - **Roon zone**: the zone you want to play to
   - **Capture device**: **BlackHole 2ch**
   - **Stream mode**: **Follow Apple Music** (starts with playback)
   - **Per-track artwork**: On
4. **Play something in Apple Music** → the source appears in that zone and starts playing.

✅ That's a working setup. Control playback (play/pause/skip) from **Apple Music**;
Roon shows now-playing, selects the zone, and offers Stop.

---

## 7. (Optional) Bit-perfect lossless

For per-track bit-perfect, BlackHole's rate must follow each track and nothing in
the chain may alter the bits.

**a. Install and launch LosslessSwitcher**
```sh
brew install --cask losslessswitcher
open -a LosslessSwitcher          # menu-bar app; switches the default output's rate per track
```
(The bridge detects the rate change and restarts the stream at the new native rate.)

**b. Apple Music → Settings → Playback**
- Audio Quality: **Lossless + Hi-Res Lossless** on
- **Sound Check: off**, **EQ: off**, **Dolby Atmos: Off** (not Automatic)

**c. Volume**: set system volume and Apple Music volume to **max (100%)** (anything lower scales the samples).

**d. Roon zone**: DSP Engine **off**, Volume Leveling **off**, volume mode **Fixed Volume**.

**e. Verify**: in Roon's now-playing, click the colored Signal Path dot — it should
show **"Lossless"** (purple) with no sample-rate-conversion / volume steps. That's
end-to-end bit-perfect.

> Endpoint ceiling: a **Squeezebox Touch maxes at 24/96**; 192 kHz gets
> downsampled by Roon (hardware limit).

---

## 8. (Optional) Run as a background service at login

After you've run it once from a terminal and granted the Automation prompt:

```sh
# Set ITUNES_COUNTRY to your Apple Music region (artwork fallback), e.g. US, TW, JP
ITUNES_COUNTRY=US ./scripts/install-service.sh

launchctl list | grep mac2roon          # confirm it's running
tail -f /tmp/mac2roon.out               # logs
./scripts/uninstall-service.sh          # remove later
```

---

## Troubleshooting

- **Crackling**: ensure capture uses sox (default in this version). Check with `npm run test:audio` — captured duration must equal the requested seconds.
- **No now-playing / can't read track**: System Settings → Privacy & Security → Automation → allow control of "Music". Under the service, you may need to run `npm start` from a terminal once to (re)grant it.
- **"Please configure zone / device"**: set both in the extension Settings.
- **Silent zone**: confirm BlackHole is the system output and Apple Music is playing.
- **Stream won't start**: try `CONTAINER=flac npm start`.
- **Pressed Stop in Roon and it jumped to another album**: expected — Roon reverts a stopped live source to its own queue. Press play in Apple Music to return to the Mac source.
- **No artwork**: Roon doesn't render per-track artwork for this source type (known platform limit).

---

## Environment variables (advanced)

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `4747` | HTTP stream port |
| `ADVERTISE_HOST` | auto LAN IP | host in the URL handed to Roon (override if autodetect is wrong) |
| `CONTAINER` | `ogg` | `ogg` (Ogg-FLAC) or `flac` |
| `ITUNES_COUNTRY` | `US` | iTunes storefront for the artwork fallback (e.g. `TW`, `JP`) |
| `POLL_MS` | `700` | Music.app poll interval (ms) |
| `LOG_LEVEL` | `info` | `debug` prints the Roon protocol trace |
