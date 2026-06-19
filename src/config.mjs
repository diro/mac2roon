// Static (env-driven) configuration. Runtime/user-facing settings (zone,
// capture device, stream mode, artwork) live in Roon's Settings UI and are
// persisted by node-roon-api into ./config.json — see roon.mjs.
import { lanAddress } from "./util.mjs";

function int(name, def) {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) ? v : def;
}

export const cfg = {
  // HTTP server that exposes the live FLAC stream + per-track artwork to Roon.
  port: int("PORT", 4747),
  bindHost: process.env.BIND_HOST || "0.0.0.0",
  advertiseHost: lanAddress(), // what we put in the URL we hand to Roon

  // Capture / encode. Capture uses sox (CoreAudio) because ffmpeg's
  // avfoundation audio input drops ~10-13% of samples (constant crackle).
  // sox captures gaplessly; ffmpeg only encodes.
  sox: process.env.SOX || "sox",
  ffmpeg: process.env.FFMPEG || "ffmpeg",
  // Output container Roon pulls. "ogg" => Ogg-FLAC (community-reported default
  // for the audioinput service); "flac" => native FLAC stream. Both lossless.
  container: (process.env.CONTAINER || "ogg").toLowerCase(),
  // NOTE on sample rate / bit-perfect: avfoundation captures at the device's
  // *native* rate and we deliberately do NOT resample. So bit-perfect is
  // controlled at the DEVICE: set BlackHole's rate in Audio MIDI Setup (or
  // drive it per-track with LosslessSwitcher) to match the Apple Music track.
  // The live capture rate is logged whenever Roon opens the stream.
  //
  // Channels: native by default (a 2ch loopback device streams stereo). Set
  // FORCE_CHANNELS=2 only if your device presents an odd channel layout.
  forceChannels: process.env.FORCE_CHANNELS ? int("FORCE_CHANNELS", 2) : null,

  // Metadata poll interval against Music.app (ms). Lower = faster start when you
  // press play (Follow mode) and faster now-playing updates, at a little more
  // osascript overhead.
  pollMs: int("POLL_MS", 700),

  // iTunes Search API storefront for the artwork fallback. Match your Apple
  // Music region so localized artist/album names resolve (e.g. TW, US, JP).
  itunesCountry: process.env.ITUNES_COUNTRY || "US",

  // Branding shown in Roon's now-playing bottom bar for this source.
  brandName: process.env.BRAND_NAME || "Mac · Apple Music",
  brandIcon:
    process.env.BRAND_ICON || "https://help.roonlabs.com/favicon.ico",

  // Roon extension identity.
  extension: {
    extension_id: process.env.EXTENSION_ID || "com.diro.mac2roon",
    display_name: process.env.DISPLAY_NAME || "Mac → Roon (Apple Music Bridge)",
    display_version: "2.0.0",
    publisher: process.env.PUBLISHER || "diro",
    email: process.env.EMAIL || "you@example.com",
    website:
      process.env.WEBSITE || "https://github.com/diro/mac2roon",
  },
};

export function streamPath() {
  return cfg.container === "flac" ? "/stream.flac" : "/stream.ogg";
}

export function streamUrl() {
  return `http://${cfg.advertiseHost}:${cfg.port}${streamPath()}`;
}

export function artUrl(token) {
  return `http://${cfg.advertiseHost}:${cfg.port}/art?v=${token}`;
}

export function streamContentType() {
  return cfg.container === "flac" ? "audio/flac" : "application/ogg";
}
