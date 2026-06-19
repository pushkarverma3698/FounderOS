#!/usr/bin/env node
/**
 * JARVIS-only dev server — web gateway on :3001 without Telegram long-poll.
 * Use when prod bot is already polling (409) or you only need the web UI.
 *
 *   pnpm dev:jarvis-gateway
 */
import { initTelemetry } from "../src/infra/telemetry.js";
import { getOffice } from "../src/agents/office.js";
import { startHealthServer } from "../src/infra/health.js";
import { logger } from "../src/infra/logger.js";

const log = logger.child({ module: "jarvis-gateway-dev" });

async function main(): Promise<void> {
  initTelemetry();
  await getOffice();
  const server = startHealthServer();
  server.ref();
  log.info("JARVIS gateway on http://127.0.0.1:3001 — no Telegram (pair with pnpm dev:jarvis-next)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
