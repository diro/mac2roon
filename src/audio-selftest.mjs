// Standalone verification of the capture -> FLAC -> HTTP path, WITHOUT Roon.
//
// Usage:
//   node src/audio-selftest.mjs [deviceIndex] [seconds]
//
// It starts the real audio server, pulls the stream over HTTP for a few
// seconds exactly like Roon would, writes it to a file, and runs ffprobe to
// confirm it decodes as lossless FLAC at the expected rate. Works against the
// built-in mic (device 0) so you can prove the pipeline before installing
// BlackHole.
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { startAudioServer } from "./audio-server.mjs";
import { setCaptureDevice } from "./audio-server.mjs";
import { cfg, streamUrl, streamPath } from "./config.mjs";
import { listAudioDevices, pickDefault } from "./devices.mjs";
import { makeLogger } from "./util.mjs";

const log = makeLogger("selftest");

const argDev = process.argv[2];
const seconds = Math.max(2, parseInt(process.argv[3] || "5", 10));

const devices = await listAudioDevices();
log.info("Devices:");
for (const d of devices) console.log(`  [${d.index}] ${d.name}`);

// argDev may be a device NAME, or a numeric index into the list, or empty.
let deviceName = null;
if (argDev != null && argDev !== "") {
  if (/^\d+$/.test(argDev)) deviceName = devices.find((d) => d.index === Number(argDev))?.name;
  else deviceName = devices.find((d) => d.name === argDev)?.name || argDev;
} else {
  deviceName = pickDefault(devices);
}
if (!deviceName) {
  log.error("No capture device available.");
  process.exit(1);
}
log.info(`Using device "${deviceName}" (sox/CoreAudio, native rate), container=${cfg.container}`);
setCaptureDevice(deviceName);

await startAudioServer();
const url = streamUrl().replace(cfg.advertiseHost, "127.0.0.1"); // local fetch
log.info(`Pulling ${url} for ${seconds}s …`);

const outFile = `/tmp/mac2roon-selftest${streamPath()}`.replace(/\//g, "_");
const tmp = `/tmp/${outFile}`;

// Use ffmpeg as the HTTP client + writer (handles the chunked stream cleanly).
const grab = () =>
  new Promise((resolve) => {
    execFile(
      cfg.ffmpeg,
      ["-y", "-hide_banner", "-loglevel", "error", "-t", String(seconds), "-i", url, "-c", "copy", tmp],
      { timeout: (seconds + 15) * 1000 },
      (err, _o, stderr) => resolve({ err, stderr })
    );
  });

const { err, stderr } = await grab();
if (err) {
  log.error("Capture failed:", stderr || err.message);
  log.error(
    "If this is a mic, macOS may need Microphone permission for your terminal (System Settings → Privacy & Security → Microphone)."
  );
  process.exit(1);
}

// Probe the captured file.
execFile(
  "ffprobe",
  ["-v", "error", "-show_entries", "stream=codec_name,sample_rate,channels,sample_fmt", "-of", "default=noprint_wrappers=1", tmp],
  (perr, pout, pstderr) => {
    if (perr) {
      log.error("ffprobe failed:", pstderr || perr.message);
      process.exit(1);
    }
    console.log("\n--- captured stream probe ---");
    console.log(pout.trim());
    const okCodec = /codec_name=flac/.test(pout);
    const rate = pout.match(/sample_rate=(\d+)/)?.[1];
    console.log("-----------------------------");
    if (okCodec) {
      log.info(
        `PASS — lossless FLAC captured at ${rate} Hz (device native rate). Saved: ${tmp}`
      );
      log.info(
        "For bit-perfect Apple Music: set this device's rate (Audio MIDI Setup / LosslessSwitcher) to match the track's rate; the rate above is what Roon will receive."
      );
      process.exit(0);
    } else {
      log.warn(`Decoded, but not FLAC (got: ${pout.trim().replace(/\n/g, ", ")}). Saved: ${tmp}`);
      process.exit(2);
    }
  }
);
