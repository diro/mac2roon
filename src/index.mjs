#!/usr/bin/env node
// mac2roon — entrypoint.
// Starts the HTTP audio server, then the Roon extension. Wire-up details live
// in audio-server.mjs and roon.mjs.
import { startAudioServer } from "./audio-server.mjs";
import { initRoon, shutdownRoon } from "./roon.mjs";
import { cfg, streamUrl } from "./config.mjs";
import { makeLogger } from "./util.mjs";

const log = makeLogger("main");

async function main() {
  log.info(`mac2roon ${cfg.extension.display_version} starting`);
  await startAudioServer();
  log.info(`stream URL (handed to Roon): ${streamUrl()}`);
  await initRoon();
}

let shuttingDown = false;
async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${sig}, shutting down…`);
  try {
    await shutdownRoon();
  } catch (e) {
    log.error("shutdown error:", e.message);
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (e) => {
  log.error("uncaughtException:", e.stack || e.message);
});
process.on("unhandledRejection", (e) => {
  log.error("unhandledRejection:", e?.stack || e);
});

main().catch((e) => {
  log.error("fatal:", e.stack || e.message);
  process.exit(1);
});
