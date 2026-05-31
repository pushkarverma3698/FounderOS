/**
 * FounderOS — Health & Metrics HTTP server
 * =========================================
 * A tiny, dependency-free (node:http) server exposing operational endpoints so
 * an agency running FounderOS can wire it to uptime monitors / load balancers.
 *
 *   GET /health   → 200 if the process is up; body reports DB + Redis liveness
 *                   and today's spend. Returns 503 if a CRITICAL dep (DB) is down.
 *   GET /metrics  → today's USD spend per tenant + uptime (plain JSON).
 *
 * Checks are tolerant: a dependency being unreachable is REPORTED, never thrown.
 * Start it from src/index.ts; stop it in the shutdown handler.
 */

import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { getPgPool } from "../db/client.js";
import { getRedis } from "./redis.js";
import { getTodayCostUsd } from "../db/queries.js";
import { childLogger } from "./logger.js";

const log = childLogger({ module: "health" });
const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version?: string };
const APP_VERSION = pkg.version ?? "0.0.0";
const startedAt = Date.now();

/** Tenants whose daily spend is surfaced in /health and /metrics. */
const TRACKED_TENANTS = ["turicks", "naggar"] as const;

async function pingDb(): Promise<boolean> {
  try {
    await getPgPool().query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

async function pingRedis(): Promise<boolean> {
  try {
    const pong = await getRedis().ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}

async function spendByTenant(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(
    TRACKED_TENANTS.map(async (t) => {
      out[t] = await getTodayCostUsd(t).catch(() => -1); // -1 signals "DB unavailable"
    }),
  );
  return out;
}

export interface HealthReport {
  status: "ok" | "degraded";
  version: string;
  uptime_s: number;
  checks: { database: "up" | "down"; redis: "up" | "down" };
  spend_today_usd: Record<string, number>;
}

/** Build the health report (exported for testing without a socket). */
export async function buildHealthReport(): Promise<HealthReport> {
  const [db, redis, spend] = await Promise.all([pingDb(), pingRedis(), spendByTenant()]);
  return {
    // DB is the only CRITICAL dependency (checkpoints, audit log, budget guard).
    // Redis is a cache → its absence is "degraded", not "down".
    status: db ? "ok" : "degraded",
    version: APP_VERSION,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    checks: { database: db ? "up" : "down", redis: redis ? "up" : "down" },
    spend_today_usd: spend,
  };
}

/**
 * Start the health server. Returns the node http.Server (call .close() to stop).
 */
export function startHealthServer(port = Number(process.env["HEALTH_PORT"] ?? 3001)): Server {
  const server = createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];

    if (req.method === "GET" && url === "/health") {
      void buildHealthReport().then((report) => {
        const code = report.checks.database === "up" ? 200 : 503;
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(report));
      });
      return;
    }

    if (req.method === "GET" && url === "/metrics") {
      void spendByTenant().then((spend) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            version: APP_VERSION,
            uptime_s: Math.round((Date.now() - startedAt) / 1000),
            spend_today_usd: spend,
          }),
        );
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  server.listen(port, () => log.info({ port }, "Health server listening on /health and /metrics"));
  // Don't keep the event loop alive on this socket alone.
  server.unref();
  return server;
}
