# mac2roon — from a one-line prompt to lossless Apple Music in Roon

> A build log of what got made with Claude Code: from a single request to a working, honest, bit-perfect bridge.

## The starting point: the prompt

> "Stream all audio from a Mac (primary purpose: **Apple Music**) to a **Roon** zone, with Roon-native now-playing, transport buttons, and zone selection. **lossless** audio quality."

Short ask — but it hides a real conflict: **Apple Music as the source** vs **Roon-native now-playing / transport / zone selection**. Those two pull against each other in Roon's architecture. The value here isn't lines of code; it's **figuring out what's actually possible versus what's a hard platform limit, then nailing the parts that are possible.**

## TL;DR of what got built

- Apple Music (and all Mac audio) streams into a chosen Roon zone as **lossless FLAC**, with **zero dropped samples** (measured).
- Roon's **now-playing** updates title/artist/album per track — **without interrupting the audio**.
- **Zone selection** uses Roon's own native picker.
- **Bit-perfect**: per-track sample-rate follow (CD ↔ hi-res), never resampled.
- Runs as a launchd background service that auto-starts at login.

Source: **https://github.com/diro/mac2roon**

## Why this is harder than it looks

Roon only renders full native now-playing/transport for sources *its own engine* plays — local library, TIDAL/Qobuz, internet radio. Apple Music is none of those, and it's FairPlay-DRM'd with no public API that yields clean audio. So step one wasn't writing code — it was **researching feasibility.**

## The engineering story (every turn backed by evidence)

**1. Research first — and overturn a common myth.**
The internet widely claims "Roon can't ingest external audio." Research showed that's **outdated**: Roon ships an official `node-roon-api-audioinput` service (`com.roonlabs.audioinput:1`) that injects an HTTP stream as a zone source, with a source name, text lines, and transport flags. The real dead end is on **Apple's side** (DRM), not Roon's. That reframing set the whole architecture: **capture system audio → encode to FLAC over HTTP → inject via audioinput.**

**2. Crackling → find the culprit by measuring, not guessing.**
The first version played, but **crackled**. The reflex is to fiddle with buffers; instead I **measured**: a 12-second capture produced only 10.6 seconds of audio. Re-tested with raw PCM and a large thread queue — **20.4 seconds of wall time yielded just 17.6 seconds of audio.** Conclusion was unambiguous: **ffmpeg's avfoundation audio input drops ~13% of samples** (a long-standing known issue). Swapped in **sox** (CoreAudio) and re-measured: **20 s → 20.000 s, zero loss.** The crackle was the capture layer, not buffering. Final pipeline: `sox captures, ffmpeg only encodes`.

**3. A bug only real hardware reveals: an AppleScript reserved word.**
Reading Music.app now-playing via osascript kept returning null — yet artwork read fine. Debug logging surfaced a syntax error (`-2741`). Isolating line by line: the variable was named `st` — and **`st` is a reserved token in AppleScript.** Renaming fixed it. This bug simply doesn't appear unless you're driving real playback against the real app.

**4. Reverse-engineering an undocumented API shape, live.**
Updating now-playing per track, `update_track_info` first returned `InvalidRequest: missing required string field: track_id`; adding `track_id` then returned `TrackNotFound`. From the real responses I derived the rule: **it only updates the track_id that `play()` established.** So the design uses **one constant "channel" track_id for the whole session** — the audio stream stays **continuous and uninterrupted**, while each song's text is refreshed via `update_track_info`, giving **gapless track changes.**

**5. Be honest about platform limits — don't fake them.**
- **Artwork**: `image_url` is sent and the local endpoint serves a valid 600×600 JPEG, but Roon **never fetches it** — Roon doesn't render per-track artwork for audioinput sources. Logged as a known limit; no effort wasted fighting it.
- **Transport**: an infinite live stream is treated by Roon as **internet radio** — Stop only, no pause/skip (`is_pause_allowed` is forced false by Roon). So the real control model is "**control from Apple Music; Roon shows now-playing + zone selection + Stop**." After a Stop, pressing play in Apple Music re-takes the zone automatically (verified).

**6. Bit-perfect: make the capture follow the sample rate.**
macOS Music.app doesn't auto-switch the output rate, so it pairs with **LosslessSwitcher** (which switches BlackHole's rate per track); the bridge detects the change via `system_profiler` and **restarts the stream at the new native rate** (same-rate track changes stay gapless). Nothing is ever resampled; 24-bit FLAC preserves ≤24-bit content exactly. Roon's **Signal Path showing "Lossless"** is the authoritative end-to-end proof.

## Final tech stack

| Layer | What |
|---|---|
| Runtime | Node.js (pure ESM), no runtime framework — just built-in `http`/`child_process` |
| Roon | `node-roon-api` + `audioinput`/`settings`/`status`/`transport` (RAAT to the endpoint) |
| Capture | BlackHole 2ch (virtual loopback) → **sox** (CoreAudio, gapless) |
| Encode/transport | **ffmpeg** → Ogg-FLAC, served chunked over Node `http`, pulled by Roon |
| Metadata/control | `osascript` (AppleScript) to read/control Music.app; iTunes Search API artwork fallback |
| Bit-perfect | LosslessSwitcher + bridge rate-follow (detect → restart) |
| Background | launchd LaunchAgent; switchaudio-osx to set the output device |

~1,600 lines, modularized into `index / roon / audio-server / music / devices / config / util`, plus a self-test and a service installer.

## Honest limitations (up front, not buried)

- Roon doesn't render **per-track artwork** for this kind of source (platform limit).
- Roon-side transport is **Stop only** (radio semantics); use Apple Music for playback control.
- **Latency** is a few seconds, mostly from Roon's and the endpoint's (here a Squeezebox Touch) stream buffering — the API exposes no knob for it.
- It taps **decoded** system audio (because of DRM), so quality equals the decoded output — which is lossless for ≤24-bit content.
- The Squeezebox Touch caps at 24/96; 192 kHz gets downsampled by Roon.

## Methodology takeaways

1. **Research feasibility before writing code.** Overturning the outdated "Roon can't ingest external audio" premise is what made the whole approach viable.
2. **Measure, don't guess.** The crackle wasn't a buffer tweak — it was pinned by a number ("20 s captured as 17.6 s") straight to the capture layer.
3. **Some bugs only appear on real hardware.** The AppleScript reserved word and the hidden `update_track_info` field both surfaced only once connected to a real Roon Core and real Apple Music playback.
4. **Treat platform limits honestly.** Do the possible well; explain the impossible (artwork, full transport) and why. That's more useful — and more credible — than faking it.

---

*Built with Claude Code, starting from a single one-line requirement, through research, on-device debugging, and several rounds of verification.*
