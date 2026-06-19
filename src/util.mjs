// Shared helpers: logging + LAN address detection.
import os from "node:os";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const WANT = LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? 2;

function stamp() {
  // Local time, seconds precision — enough to correlate with Roon/ffmpeg logs.
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function emit(level, tag, args) {
  if ((LEVELS[level] ?? 2) > WANT) return;
  const line = `${stamp()} ${level.toUpperCase().padEnd(5)} [${tag}]`;
  // error/warn -> stderr, rest -> stdout
  const sink = level === "error" || level === "warn" ? console.error : console.log;
  sink(line, ...args);
}

export function makeLogger(tag) {
  return {
    error: (...a) => emit("error", tag, a),
    warn: (...a) => emit("warn", tag, a),
    info: (...a) => emit("info", tag, a),
    debug: (...a) => emit("debug", tag, a),
  };
}

// Best-effort primary LAN IPv4. The Roon Core may be a separate machine
// (Nucleus/NUC/ROCK), so the stream URL we hand Roon must be reachable on the
// LAN — never 127.0.0.1. Allow an explicit override via ADVERTISE_HOST.
export function lanAddress() {
  if (process.env.ADVERTISE_HOST) return process.env.ADVERTISE_HOST;
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family !== "IPv4" || ni.internal) continue;
      // Prefer common LAN ranges; de-prioritize odd virtual adapters.
      const isPrivate =
        /^10\./.test(ni.address) ||
        /^192\.168\./.test(ni.address) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(ni.address);
      candidates.push({ address: ni.address, name, isPrivate });
    }
  }
  candidates.sort((a, b) => Number(b.isPrivate) - Number(a.isPrivate));
  return candidates[0]?.address || "127.0.0.1";
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
