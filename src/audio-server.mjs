// HTTP server that Roon pulls from:
//   GET /stream.ogg (or /stream.flac)  -> live, lossless FLAC of captured audio
//   GET /art?v=<token>                 -> current track artwork (set by roon.mjs)
//   GET /health                        -> "ok"
//
// Capture is per-connection: each GET spawns an ffmpeg reading the configured
// avfoundation device and encoding to FLAC. ffmpeg is killed when Roon
// disconnects. We do NOT resample (no -ar on the output) so the path stays
// bit-perfect as long as the device/Music.app rate matches cfg.sampleRate.
import http from "node:http";
import { spawn } from "node:child_process";
import { cfg, streamPath, streamContentType } from "./config.mjs";
import { makeLogger } from "./util.mjs";

const log = makeLogger("audio");

let currentArt = null; // { buffer, contentType }
let captureDeviceName = null; // CoreAudio device name (sox), set by roon.mjs
let activeProcs = new Set(); // { sox, ff } pairs
let lastCaptureRate = null; // parsed from ffmpeg for bit-perfect verification

export function setCaptureDevice(name) {
  captureDeviceName = name;
}
export function getLastCaptureRate() {
  return lastCaptureRate;
}
export function setArtwork(buffer, contentType) {
  currentArt = buffer ? { buffer, contentType } : null;
}

// sox captures CoreAudio (gapless) -> WAV on stdout; ffmpeg encodes WAV ->
// FLAC (Ogg or raw) on stdout. We never resample, so the device's native rate
// flows straight through (bit-perfect).
function spawnCapture() {
  if (!captureDeviceName) {
    throw new Error("capture device not configured");
  }
  const sox = spawn(
    cfg.sox,
    ["-q", "-t", "coreaudio", captureDeviceName, "-t", "wav", "-"],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const ff = spawn(
    cfg.ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "info", // parse "Audio: ... Hz" once for the bit-perfect rate log
      "-nostats", // no recurring progress lines (avoids stderr spam/jank)
      // Low-latency input: don't sit there probing/analyzing the WAV pipe before
      // emitting — start encoding ASAP to cut startup delay.
      "-fflags",
      "nobuffer",
      "-probesize",
      "32768",
      "-analyzeduration",
      "0",
      "-i",
      "pipe:0",
      "-c:a",
      "flac",
      "-compression_level",
      "0", // lowest CPU/latency jitter; still lossless
      "-flush_packets",
      "1",
      "-f",
      cfg.container === "flac" ? "flac" : "ogg",
      "pipe:1",
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );

  const pair = { sox, ff };
  activeProcs.add(pair);

  sox.stdout.pipe(ff.stdin);
  // Swallow EPIPE when one side dies first.
  sox.stdout.on("error", () => {});
  ff.stdin.on("error", () => {});

  sox.stderr.on("data", (d) => {
    const s = d.toString().trim();
    if (s) log.debug("sox:", s);
  });
  ff.stderr.on("data", (d) => {
    const s = d.toString().trim();
    if (!s) return;
    const m = s.match(/Audio:.*?(\d{4,6})\s*Hz/);
    if (m) {
      lastCaptureRate = Number(m[1]);
      log.info(`capture rate: ${lastCaptureRate} Hz (${captureDeviceName})`);
    }
    log.debug("ffmpeg:", s);
  });

  const killPair = () => {
    activeProcs.delete(pair);
    for (const p of [sox, ff]) {
      if (p && !p.killed) {
        try {
          p.kill("SIGKILL");
        } catch {}
      }
    }
  };
  sox.on("close", (code, sig) => {
    log.debug(`sox exited code=${code} sig=${sig}`);
    killPair();
  });
  ff.on("close", (code, sig) => {
    log.debug(`ffmpeg exited code=${code} sig=${sig}`);
    killPair();
  });
  sox.on("error", (e) => log.error("sox spawn error:", e.message));
  ff.on("error", (e) => log.error("ffmpeg spawn error:", e.message));

  return pair;
}

function handleStream(req, res) {
  let pair;
  try {
    pair = spawnCapture();
  } catch (e) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end(`capture not ready: ${e.message}`);
    return;
  }
  res.writeHead(200, {
    "Content-Type": streamContentType(),
    "Cache-Control": "no-cache, no-store",
    Connection: "close",
    // No Content-Length => chunked/streaming, i.e. an endless "radio" stream.
  });
  log.info(`stream opened by ${req.socket.remoteAddress} (${captureDeviceName})`);

  pair.ff.stdout.pipe(res);
  pair.ff.stdout.on("error", () => {});

  const cleanup = (why) => {
    activeProcs.delete(pair);
    for (const p of [pair.sox, pair.ff]) {
      if (p && !p.killed) {
        try {
          p.kill("SIGKILL");
        } catch {}
      }
    }
    log.info(`stream closed (${why})`);
  };
  res.on("close", () => cleanup("client closed"));
}

function handleArt(req, res) {
  log.debug(`/art requested by ${req.socket.remoteAddress} (have art: ${!!currentArt})`);
  if (!currentArt) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("no artwork");
    return;
  }
  res.writeHead(200, {
    "Content-Type": currentArt.contentType,
    "Cache-Control": "no-cache",
  });
  res.end(currentArt.buffer);
}

export function startAudioServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    } else if (url.pathname === streamPath()) {
      handleStream(req, res);
    } else if (url.pathname === "/art") {
      handleArt(req, res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(cfg.port, cfg.bindHost, () => {
      log.info(`HTTP server on ${cfg.bindHost}:${cfg.port}  stream=${streamPath()}`);
      resolve(server);
    });
  });
}

export function killAllCaptures() {
  for (const pair of activeProcs) {
    for (const p of [pair.sox, pair.ff]) {
      try {
        p.kill("SIGKILL");
      } catch {}
    }
  }
  activeProcs.clear();
}
