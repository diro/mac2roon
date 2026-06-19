// Roon extension wiring: discovery/pairing, Settings UI (zone + capture device +
// stream mode + artwork), status, the audioinput session, the Music.app metadata
// poller, and inbound transport-button mapping.
import RoonApi from "node-roon-api";
import RoonApiSettings from "node-roon-api-settings";
import RoonApiStatus from "node-roon-api-status";
import RoonApiTransport from "node-roon-api-transport";
import RoonApiAudioInput from "node-roon-api-audioinput";

import { cfg, streamUrl, artUrl } from "./config.mjs";
import { makeLogger } from "./util.mjs";
import { listAudioDevices, pickDefault, getDeviceRate } from "./devices.mjs";
import {
  setCaptureDevice,
  setArtwork,
  killAllCaptures,
} from "./audio-server.mjs";
import {
  getNowPlaying,
  getArtwork,
  contentTypeFor,
  lookupArtworkUrl,
  music,
} from "./music.mjs";

const log = makeLogger("roon");

const V = {
  roon: null,
  core: null,
  zones: null,
  currentZone: null, // resolved zone object
  session: null, // { session_id, end_session() }
  sessionId: null,
  streaming: false,
  starting: false, // re-entrancy guard: begin_session is async; poll fires every pollMs
  playGen: 0, // generation counter so a superseded play()'s callbacks go stale
  streamRate: null, // device rate the current stream opened at (for bit-perfect rate-follow)
  checkingRate: false, // guard against overlapping system_profiler calls
  roonPaused: false, // we paused Music because Roon paused; resume on Playing
  lastTrackId: null,
  lastMusicState: null, // 'playing' | 'paused' | 'stopped' | null(not running)
  restartCount: 0,
  restartTimer: null,
  devices: [],
};

let settings = {};
let svcStatus;
let svcAudioInput; // core.services.RoonApiAudioInput
let svcTransport; // core.services.RoonApiTransport

function status(text, isError = false) {
  if (svcStatus) svcStatus.set_status(text, isError);
}

// ---- settings / zone -------------------------------------------------------

function makeLayout(s) {
  const deviceValues = V.devices.map((d) => ({
    title: d.name,
    value: d.name,
  }));
  if (!deviceValues.length)
    deviceValues.push({ title: "(no devices found — install BlackHole)", value: "" });

  return {
    values: s,
    layout: [
      { type: "zone", title: "Roon zone", setting: "output" },
      {
        type: "dropdown",
        title: "Capture device",
        subtitle:
          "The macOS device sox captures (CoreAudio). Pick BlackHole (or your loopback/aggregate device).",
        setting: "device_name",
        values: deviceValues,
      },
      {
        type: "dropdown",
        title: "Stream mode",
        subtitle:
          "Follow = appear in Roon only while Apple Music plays. Always-on = stream all Mac audio continuously.",
        setting: "stream_mode",
        values: [
          { title: "Follow Apple Music", value: "follow" },
          { title: "Always on (all Mac audio)", value: "always" },
        ],
      },
      {
        type: "dropdown",
        title: "Per-track artwork",
        subtitle: "Push Apple Music cover art to Roon's now-playing (best effort).",
        setting: "artwork",
        values: [
          { title: "On", value: "on" },
          { title: "Off", value: "off" },
        ],
      },
    ],
    has_error: false,
  };
}

function applySettings(next) {
  const prevDevice = settings.device_name;
  const prevZone = settings.output?.output_id;
  const prevMode = settings.stream_mode;
  settings = next;

  if (settings.device_name) setCaptureDevice(settings.device_name);

  resolveZone();

  const deviceChanged = prevDevice !== settings.device_name;
  const zoneChanged = prevZone !== settings.output?.output_id;
  const modeChanged = prevMode !== settings.stream_mode;

  if ((deviceChanged || zoneChanged) && V.streaming) {
    log.info("Device/zone changed — restarting stream");
    stopStreaming().then(() => evaluate());
  } else if (modeChanged) {
    evaluate();
  } else {
    evaluate();
  }
}

// Map the chosen output_id to a zone object (audioinput needs a zone_id).
function resolveZone() {
  const outId = settings.output?.output_id;
  V.currentZone = null;
  if (!V.zones || !outId) return;
  for (const zid of Object.keys(V.zones)) {
    const z = V.zones[zid];
    if (z.outputs?.some((o) => o.output_id === outId)) {
      V.currentZone = z;
      return;
    }
  }
}

// ---- audioinput session ----------------------------------------------------

function buildInfo(np) {
  const title = np?.title || cfg.brandName;
  const artist = np?.artist || "";
  const album = np?.album || "";
  const info = {
    is_seek_allowed: false, // live capture — seeking is meaningless
    is_pause_allowed: true,
    one_line: { line1: artist ? `${title} — ${artist}` : title },
    two_line: { line1: title, line2: artist || album },
    three_line: { line1: title, line2: artist, line3: album },
  };
  if (np?.durationSec) info.length = np.durationSec;
  return info;
}

// Attach artwork (image_url) to an info object. Two sources, in order:
//  1) Music.app's embedded artwork bytes, served via our /art proxy (exact;
//     available for downloaded/local tracks). cacheToken = song id busts cache.
//  2) iTunes Search API cover URL (public https; works for streaming tracks
//     where Music.app exposes no bytes). Roon fetches it directly.
async function withArtwork(info, np) {
  if (settings.artwork === "off") return info;
  const cacheToken = np?.trackId || String(Date.now());
  try {
    const art = await getArtwork();
    if (art) {
      setArtwork(art.buffer, contentTypeFor(art.ext));
      info.image_url = artUrl(cacheToken);
      return info;
    }
  } catch (e) {
    log.debug("artwork (local) error:", e.message);
  }
  try {
    const url = await lookupArtworkUrl(np, cfg.itunesCountry);
    if (url) {
      info.image_url = url;
      return info;
    }
  } catch (e) {
    log.debug("artwork (itunes) error:", e.message);
  }
  setArtwork(null);
  return info;
}

// Start playback ONCE per session with a CONSTANT "channel" track_id. The
// media_url is a single continuous capture, so we never re-play on track change
// (that tears the stream down and crackles). Metadata changes go through
// update_track_info() against this same track_id.
async function startPlay(np) {
  if (!V.sessionId) return;
  V.channelTrackId = `m2r-${V.sessionId}`; // stable for the whole session
  const info = await withArtwork(buildInfo(np), np);
  V.lastTrackId = np?.trackId || null;
  const gen = ++V.playGen;
  svcAudioInput.play(
    {
      session_id: V.sessionId,
      type: "channel",
      slot: "play",
      media_url: streamUrl(),
      track_id: V.channelTrackId,
      info,
    },
    (m, b) => onPlayMessage(m, b, gen)
  );
}

// Update now-playing metadata mid-stream WITHOUT touching the audio, using the
// SAME constant track_id play() established (a new id returns TrackNotFound).
async function updateNowPlaying(np) {
  if (!V.sessionId || !V.channelTrackId) return;
  const info = await withArtwork(buildInfo(np), np);
  svcAudioInput.update_track_info(
    { session_id: V.sessionId, track_id: V.channelTrackId, info },
    (m, b) => {
      const name = m?.name ?? m;
      if (name === "TrackNotFound" || name === "InvalidRequest" || name === "Error")
        log.warn(`update_track_info ${name}:`, JSON.stringify(b || ""));
      else log.debug("update_track_info reply:", name);
    }
  );
}

async function startStreaming() {
  // Guard re-entrancy: V.streaming only flips true inside the async
  // SessionBegan callback, so without V.starting a poll tick could fire a
  // second begin_session in the gap.
  if (V.streaming || V.starting) return;
  if (!V.core || !V.currentZone) {
    status("Please configure zone & device", true);
    return;
  }
  if (!settings.device_name) {
    status("No capture device selected", true);
    return;
  }
  status("Preparing…");
  V.starting = true;
  // Safety: if the Core never calls back, don't wedge the guard forever.
  const startGuard = setTimeout(() => {
    if (V.starting) {
      log.warn("begin_session timed out without reply — clearing start guard");
      V.starting = false;
    }
  }, 10000);
  const np = await getNowPlaying().catch(() => null);
  // Record the device rate this stream opens at, so the rate-watcher can detect
  // a LosslessSwitcher rate change and restart for bit-perfect.
  V.streamRate = await getDeviceRate(settings.device_name).catch(() => null);

  V.session = svcAudioInput.begin_session(
    {
      zone_id: V.currentZone.zone_id,
      display_name: cfg.brandName,
      icon_url: cfg.brandIcon,
    },
    (msg, body) => {
      clearTimeout(startGuard);
      V.starting = false;
      if (msg === "SessionBegan") {
        V.sessionId = body.session_id;
        V.streaming = true;
        V.restartCount = 0;

        // Enable prev/next buttons. NOTE: the published example disables these,
        // so the exact INBOUND message names for next/prev aren't documented.
        // We enable them and log every inbound message (see play cb) to confirm
        // the names against your Core on first use.
        svcAudioInput.update_transport_controls(
          {
            session_id: V.sessionId,
            controls: { is_previous_allowed: true, is_next_allowed: true },
          },
          () => {}
        );

        // Start the continuous stream once; track changes use update_track_info.
        startPlay(np);
      } else if (msg === "ZoneNotFound" || msg === "ZoneLost") {
        status("Zone unavailable", true);
        V.streaming = false;
      } else if (msg === "SessionEnded") {
        V.streaming = false;
        V.sessionId = null;
        status("Ready");
      }
    }
  );
}

function onPlayMessage(m, b, gen) {
  const name = m?.name ?? m; // be tolerant of shape
  // Ignore terminal/transport actions from a superseded play() (a previous
  // track on the same continuous stream). Stale Time/Ended must not act.
  const stale = gen != null && gen !== V.playGen;
  switch (name) {
    case "Playing":
      if (stale) break;
      status("Playing…");
      if (V.roonPaused) {
        V.roonPaused = false;
        music.play();
      }
      break;
    case "Time":
      break; // position tick — ignore
    case "Paused":
      if (stale) break;
      // Roon paused our source. Pause Music.app too so they stay in sync.
      V.roonPaused = true;
      status("Paused");
      music.pause();
      break;
    case "StoppedUser":
      if (stale) break;
      status("Ready");
      music.pause();
      stopStreaming();
      break;
    case "EndedNaturally":
    case "MediaError":
      if (stale) break; // a replaced track ending is expected, not an error
      log.warn(`Stream ended (${name}).`, b ? JSON.stringify(b) : "");
      scheduleRestart();
      break;
    case "ZoneNotFound":
    case "ZoneLost":
      status("Zone unavailable", true);
      V.streaming = false;
      break;
    case "Cleared":
      break; // track/queue cleared — informational
    default:
      // Most likely the prev/next button presses we enabled. Log loudly so the
      // real message names can be confirmed, and take a best-effort guess.
      log.warn(
        `UNHANDLED audioinput message — please report the exact name: name=${JSON.stringify(
          name
        )} body=${JSON.stringify(b)}`
      );
      if (/next/i.test(String(name))) music.next();
      else if (/prev/i.test(String(name))) music.previous();
      break;
  }
}

function scheduleRestart() {
  V.streaming = false;
  // The stream already ended on Roon's side; drop the stale session handle so
  // the restart's begin_session doesn't leave an orphaned session.
  V.session = null;
  V.sessionId = null;
  if (V.restartTimer) return;
  if (V.restartCount >= 5) {
    log.error("Too many stream restarts — giving up until next track/playback.");
    status("Stream error — check logs", true);
    return;
  }
  const delay = Math.min(1000 * 2 ** V.restartCount, 15000);
  V.restartCount++;
  log.info(`Restarting stream in ${delay}ms (attempt ${V.restartCount})`);
  V.restartTimer = setTimeout(() => {
    V.restartTimer = null;
    evaluate(true);
  }, delay);
}

async function stopStreaming() {
  if (V.session) {
    try {
      V.session.end_session(() => {});
    } catch (e) {
      log.debug("end_session error:", e.message);
    }
  }
  V.session = null;
  V.sessionId = null;
  V.streaming = false;
  V.roonPaused = false;
  V.streamRate = null;
  killAllCaptures();
  status("Ready");
}

// Bit-perfect rate-follow: if LosslessSwitcher changed BlackHole's rate (a
// CD↔hi-res boundary), the continuous FLAC stream — fixed at the old rate —
// must be restarted so sox re-opens at the new native rate. Same-rate track
// changes never hit this (they stay gapless via update_track_info).
async function checkRate() {
  if (!V.streaming || V.starting || V.checkingRate || !settings.device_name) return;
  if (V.streamRate == null) return;
  V.checkingRate = true;
  try {
    const r = await getDeviceRate(settings.device_name);
    if (r && r !== V.streamRate) {
      log.info(`device rate ${V.streamRate} -> ${r} Hz; restarting stream (bit-perfect)`);
      await stopStreaming();
      await evaluate(true); // re-open sox at the new rate
    }
  } catch (e) {
    log.debug("checkRate error:", e.message);
  } finally {
    V.checkingRate = false;
  }
}

// ---- main evaluation loop --------------------------------------------------
// Decides whether we should be streaming based on mode + Music.app state, and
// keeps now-playing fresh.
async function evaluate(force = false) {
  if (!V.core) {
    status("Ready to pair", true);
    return;
  }
  if (!V.currentZone) {
    status("Please configure zone", true);
    return;
  }
  if (!settings.device_name) {
    status("Select a capture device in Settings", true);
    return;
  }

  const np = await getNowPlaying().catch(() => null);
  const state = np?.state ?? null; // null => Music not running
  V.lastMusicState = state;

  const mode = settings.stream_mode || "follow";

  if (mode === "always") {
    if (!V.streaming) await startStreaming();
  } else {
    // follow Apple Music
    if (state === "playing") {
      if (!V.streaming) await startStreaming();
    } else if (state === "paused") {
      // keep the session (so resume is instant) but do nothing
    } else {
      // stopped or not running -> release the zone back to Roon
      if (V.streaming) await stopStreaming();
    }
  }

  // Track-change detection -> update metadata only (audio stream untouched).
  if (V.streaming && np && np.trackId && np.trackId !== V.lastTrackId) {
    V.lastTrackId = np.trackId; // set first to avoid a double-trigger next tick
    log.info(`track change -> ${np.title} — ${np.artist}`);
    await updateNowPlaying(np);
    // LosslessSwitcher switches BlackHole's rate shortly after a track starts;
    // check a beat later so a hi-res/CD boundary triggers a bit-perfect restart.
    setTimeout(() => checkRate(), 1300);
  }

  if (force && !V.streaming && (mode === "always" || state === "playing")) {
    await startStreaming();
  }
}

let pollTimer = null;
let tickCount = 0;
function startPolling() {
  if (pollTimer) return;
  const tick = async () => {
    try {
      await evaluate();
      // Backstop rate-watch (~every 3s) in case a rate change isn't tied to a
      // track-change event we saw.
      if (++tickCount % 4 === 0) await checkRate();
    } catch (e) {
      log.error("poll error:", e.message);
    }
    pollTimer = setTimeout(tick, cfg.pollMs);
  };
  tick();
}

// ---- init ------------------------------------------------------------------

export async function initRoon() {
  V.devices = await listAudioDevices();
  const defaultDevice = pickDefault(V.devices);

  V.roon = new RoonApi({
    ...cfg.extension,
    log_level: process.env.LOG_LEVEL === "debug" ? "all" : "none",
    force_server: true,

    core_paired: (core) => {
      log.info("Paired with Roon Core:", core.display_name || core.core_id);
      V.core = core;
      svcAudioInput = core.services.RoonApiAudioInput;
      svcTransport = core.services.RoonApiTransport;

      svcTransport.subscribe_zones((response, msg) => {
        if (response === "Subscribed") {
          V.zones = {};
          (msg.zones || []).forEach((z) => (V.zones[z.zone_id] = z));
        } else if (response === "Changed") {
          if (msg.zones_removed) msg.zones_removed.forEach((z) => delete V.zones[z.zone_id]);
          if (msg.zones_added) msg.zones_added.forEach((z) => (V.zones[z.zone_id] = z));
          if (msg.zones_changed) msg.zones_changed.forEach((z) => (V.zones[z.zone_id] = z));
        }
        resolveZone();
      });

      resolveZone();
      startPolling();
      status("Ready");
    },

    core_unpaired: () => {
      log.warn("Unpaired from Roon Core");
      stopStreaming();
      V.core = null;
      V.zones = null;
      V.currentZone = null;
    },
  });

  // Load persisted settings (node-roon-api stores these in ./config.json).
  settings =
    V.roon.load_config("settings") || {
      output: undefined,
      device_name: defaultDevice || "",
      stream_mode: "follow",
      artwork: "on",
    };
  // Default/migrate the capture device to a detected one (e.g. BlackHole).
  if (!settings.device_name && defaultDevice) settings.device_name = defaultDevice;
  if (settings.device_name) setCaptureDevice(settings.device_name);

  const svcSettings = new RoonApiSettings(V.roon, {
    get_settings: (cb) => cb(makeLayout(settings)),
    save_settings: (req, isdryrun, s) => {
      const l = makeLayout(s.values);
      req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });
      if (!isdryrun && !l.has_error) {
        applySettings(l.values);
        V.roon.save_config("settings", settings);
      }
    },
  });

  svcStatus = new RoonApiStatus(V.roon);

  V.roon.init_services({
    provided_services: [svcSettings, svcStatus],
    required_services: [RoonApiAudioInput, RoonApiTransport],
  });

  status("Ready to pair", true);
  V.roon.start_discovery();
  log.info("Discovery started. Enable the extension in Roon → Settings → Extensions.");

  return V;
}

// Graceful shutdown.
export async function shutdownRoon() {
  if (pollTimer) clearTimeout(pollTimer);
  await stopStreaming();
}
