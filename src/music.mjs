// Apple Music (Music.app) bridge via AppleScript / osascript.
//
//  - Reads now-playing (title/artist/album/state/duration/track id).
//  - Extracts per-track artwork bytes (best effort).
//  - Drives transport (play/pause/next/previous) so Roon's transport buttons
//    can be mapped back to Music.app.
//
// PERMISSIONS: the first time this controls or reads Music.app, macOS shows a
// TCC "Automation" consent prompt for the process running node (your terminal,
// or the LaunchAgent). You must allow it, or every call fails with errAEEvent
// (-1743). See README → Permissions.
//
// macOS 15.4+ note: the *system-wide* MediaRemote now-playing API was locked to
// entitled Apple processes. We deliberately do NOT use it — we talk to Music.app
// directly via its scripting dictionary, which still works per-app.
import { execFile } from "node:child_process";
import { makeLogger } from "./util.mjs";

const log = makeLogger("music");
const DELIM = ""; // unit separator — safe against titles containing it

function osascript(script, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", script],
      { timeout: 8000, maxBuffer: 16 * 1024 * 1024, encoding: binary ? "buffer" : "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr?.toString?.() ?? String(stderr);
          return reject(err);
        }
        resolve(binary ? stdout : String(stdout).replace(/\n$/, ""));
      }
    );
  });
}

// Returns null if Music.app isn't running, else:
//   { state: 'playing'|'paused'|'stopped', title, artist, album, trackId, durationSec }
export async function getNowPlaying() {
  const script = `
set d to (character id 31)
if application "Music" is running then
  tell application "Music"
    set ps to (player state as text)
    if ps is "stopped" then return "stopped" & d & d & d & d & d & "0"
    try
      set nm to (name of current track) as text
    on error
      set nm to ""
    end try
    try
      set ar to (artist of current track) as text
    on error
      set ar to ""
    end try
    try
      set al to (album of current track) as text
    on error
      set al to ""
    end try
    try
      set pid to (persistent ID of current track) as text
    on error
      set pid to ""
    end try
    try
      set dur to (duration of current track) as text
    on error
      set dur to "0"
    end try
    return ps & d & nm & d & ar & d & al & d & pid & d & dur
  end tell
else
  return "NOTRUNNING"
end if`;
  let raw;
  try {
    raw = await osascript(script);
  } catch (e) {
    log.debug("getNowPlaying failed:", e.stderr || e.message);
    return null;
  }
  if (raw === "NOTRUNNING") return null;
  const [state, title, artist, album, trackId, dur] = raw.split(DELIM);
  return {
    state,
    title: title || "",
    artist: artist || "",
    album: album || "",
    trackId: trackId || "",
    durationSec: Math.round(parseFloat(dur || "0")) || 0,
  };
}

// Best-effort artwork bytes for the current track. Returns {buffer, ext} or null.
// AppleScript writes the raw image bytes to a temp file; we read + sniff format.
export async function getArtwork(tmpPath = "/tmp/mac2roon-art.bin") {
  const script = `
if application "Music" is running then
  tell application "Music"
    if (player state as text) is "stopped" then return "NOART"
    try
      if (count of artworks of current track) is 0 then return "NOART"
      set rawData to raw data of artwork 1 of current track
    on error
      return "NOART"
    end try
  end tell
  set outPath to "${tmpPath}"
  try
    set fh to open for access (POSIX file outPath) with write permission
    set eof fh to 0
    write rawData to fh
    close access fh
  on error errMsg
    try
      close access (POSIX file outPath)
    end try
    return "WRITEFAIL:" & errMsg
  end try
  return "OK"
else
  return "NOTRUNNING"
end if`;
  let res;
  try {
    res = await osascript(script);
  } catch (e) {
    log.debug("getArtwork failed:", e.stderr || e.message);
    return null;
  }
  if (res !== "OK") return null;
  const { readFile } = await import("node:fs/promises");
  let buf;
  try {
    buf = await readFile(tmpPath);
  } catch {
    return null;
  }
  if (!buf?.length) return null;
  return { buffer: buf, ext: sniff(buf) };
}

function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return "jpg";
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  )
    return "png";
  return "bin";
}

export function contentTypeFor(ext) {
  return ext === "png" ? "image/png" : ext === "jpg" ? "image/jpeg" : "application/octet-stream";
}

// Fallback artwork: look up a public cover-art URL via the iTunes Search API.
// Works for streaming tracks where Music.app exposes no embedded artwork bytes.
// Returns a high-res https URL (Roon fetches it directly) or null.
export async function lookupArtworkUrl(np, country = "US") {
  if (!np) return null;
  const term = [np.artist, np.album || np.title].filter(Boolean).join(" ").trim();
  if (!term) return null;
  const url =
    `https://itunes.apple.com/search?term=${encodeURIComponent(term)}` +
    `&entity=album&limit=1&country=${encodeURIComponent(country)}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = await r.json();
    const art = j.results?.[0]?.artworkUrl100;
    if (!art) return null;
    // Upscale the default 100x100 thumbnail to 600x600.
    return art.replace(/\/\d+x\d+bb\./, "/600x600bb.");
  } catch (e) {
    log.debug("iTunes artwork lookup failed:", e.message);
    return null;
  }
}

// --- transport ------------------------------------------------------------
async function tell(cmd) {
  try {
    await osascript(`if application "Music" is running then tell application "Music" to ${cmd}`);
    return true;
  } catch (e) {
    log.warn(`Music command "${cmd}" failed:`, e.stderr || e.message);
    return false;
  }
}

export const music = {
  play: () => tell("play"),
  pause: () => tell("pause"),
  playpause: () => tell("playpause"),
  next: () => tell("next track"),
  previous: () => tell("previous track"),
};
