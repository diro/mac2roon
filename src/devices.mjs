// Enumerate macOS avfoundation audio capture devices via ffmpeg.
//
// ffmpeg prints the device list to STDERR (and exits non-zero) when asked to
// "-list_devices true" with an empty input — that's expected, not an error.
import { execFile } from "node:child_process";
import { cfg } from "./config.mjs";
import { makeLogger } from "./util.mjs";

const log = makeLogger("devices");

export function listAudioDevices() {
  return new Promise((resolve) => {
    execFile(
      cfg.ffmpeg,
      ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
      { timeout: 10_000 },
      (_err, _stdout, stderr) => {
        resolve(parseDevices(stderr || ""));
      }
    );
  });
}

// Parse the "AVFoundation audio devices:" block. Lines look like:
//   [AVFoundation indev @ 0x..] [2] BlackHole 2ch
export function parseDevices(stderr) {
  const lines = stderr.split("\n");
  const out = [];
  let inAudio = false;
  for (const raw of lines) {
    if (/AVFoundation audio devices:/.test(raw)) {
      inAudio = true;
      continue;
    }
    if (/AVFoundation video devices:/.test(raw)) {
      inAudio = false;
      continue;
    }
    if (!inAudio) continue;
    const m = raw.match(/\]\s*\[(\d+)\]\s*(.+?)\s*$/);
    if (m) out.push({ index: Number(m[1]), name: m[2] });
  }
  return out;
}

// Read a CoreAudio device's CURRENT nominal sample rate (Hz), or null.
// Used to detect when LosslessSwitcher switches BlackHole's rate per track.
export function getDeviceRate(name) {
  return new Promise((resolve) => {
    execFile(
      "system_profiler",
      ["-json", "SPAudioDataType"],
      { timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          const items = JSON.parse(stdout).SPAudioDataType?.[0]?._items || [];
          const it = items.find((x) => x._name === name);
          const sr = it?.coreaudio_device_srate ?? it?.coreaudio_device_sample_rate;
          resolve(sr ? Number(sr) : null);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

// Pick a sensible default device NAME: prefer a virtual loopback device
// (BlackHole / Loopback / Aggregate), else fall back to the first device.
// Names (not indices) are used because the capture engine is sox/CoreAudio.
export function pickDefault(devices) {
  const pref = devices.find((d) =>
    /blackhole|loopback|aggregate|multi[- ]?output|soundflower/i.test(d.name)
  );
  return (pref || devices[0])?.name;
}

// CLI entrypoint: `npm run devices`
if (import.meta.url === `file://${process.argv[1]}`) {
  const devices = await listAudioDevices();
  if (!devices.length) {
    log.warn("No avfoundation audio devices found.");
  } else {
    log.info("Capture devices:");
    for (const d of devices) console.log(`  [${d.index}] ${d.name}`);
    const def = pickDefault(devices);
    log.info(`Suggested default: ${def}`);
    if (!devices.some((d) => /blackhole|loopback/i.test(d.name))) {
      log.warn(
        "No BlackHole/Loopback found. Install BlackHole to capture system/Apple Music audio (see README)."
      );
    }
  }
}
