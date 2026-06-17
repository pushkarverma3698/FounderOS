#!/usr/bin/env node
/**
 * FounderOS — Daily Health Boot Probe
 * Boots office + health HTTP server (no Telegram), curls /health, exits.
 */
import { createServer, type Server } from "node:http";
import { getOffice } from "../src/agents/office.js";
import { closeDatabaseConnections, getPgPool } from "../src/db/client.js";

const PORT = Number(process.env["HEALTH_PORT"] ?? 3001);
const TIMEOUT_MS = 30_000;

async function waitForHealth(url: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastErr = "unknown";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      const body = (await res.json()) as Record<string, unknown>;
      if (res.ok) return body;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Health probe timed out after ${TIMEOUT_MS}ms: ${lastErr}`);
}

async function main(): Promise<void> {
  console.log("Daily health probe — compiling office...");
  await getOffice();

  // Minimal /health handler — same contract as production without full index.ts boot.
  let server: Server | undefined;
  await new Promise<void>((resolve, reject) => {
    server = createServer(async (_req, res) => {
      try {
        await getPgPool().query("SELECT 1");
        const payload = {
          status: "ok",
          checks: { database: "up" },
          probe: "daily-health-probe",
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      } catch {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "degraded", checks: { database: "down" } }));
      }
    });
    server.on("error", reject);
    server.listen(PORT, "127.0.0.1", () => resolve());
  });

  try {
    const url = `http://127.0.0.1:${PORT}/health`;
    console.log(`Curling ${url}...`);
    const body = await waitForHealth(url);
    const checks = body["checks"] as { database?: string } | undefined;
    if (body["status"] !== "ok" || checks?.database !== "up") {
      throw new Error(`Unexpected health body: ${JSON.stringify(body)}`);
    }
    console.log(`PASS health_boot: status=ok database=up port=${PORT}`);
  } finally {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await closeDatabaseConnections().catch(() => {});
  }
}

main().catch((err) => {
  console.error("FAIL health_boot:", err);
  process.exit(1);
});
