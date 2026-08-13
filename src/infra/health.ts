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
import { join } from "node:path";
import { getPgPool } from "../db/client.js";
import { getTodayCostUsd, getKnowledgeEntryCount, getTuricksBrainCount } from "../db/queries.js";
import { childLogger } from "./logger.js";
import { runProviderProbes, getLastProviderProbe } from "./provider-probes.js";
import { getGmailBackend } from "./provider-config.js";
// startTurn is deliberately NOT imported: the health server has no path that
// runs a real turn, so it must never mint a trace turnId. See the /api/v1/dispatch
// and /api/v1/hitl/respond handlers below for the forgery this prevents.
import { setTraceSink, type TraceEvent } from "./trace.js";
import { handleDispatch, handleHitlRespond } from "./health-api-stubs.js";

const log = childLogger({ module: "health" });

const recentTraceEvents: TraceEvent[] = [];
const sseClients = new Set<import("node:http").ServerResponse>();

// Register TraceSink to buffer and broadcast live trace events over SSE
setTraceSink((event: TraceEvent) => {
  recentTraceEvents.push(event);
  if (recentTraceEvents.length > 500) {
    recentTraceEvents.shift();
  }
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
});

/**
 * Read the app version from package.json.
 *
 * Must work from BOTH run modes — source (`tsx src/index.ts`, this file at
 * `src/infra/health.ts`) and compiled (`node dist/src/index.js`, this file at
 * `dist/src/infra/health.js`). A relative `../../package.json` resolves to the
 * repo root in source but to the missing `dist/package.json` once compiled, so
 * we anchor on `process.cwd()` (the repo root for both documented commands).
 *
 * This is cosmetic (only the /health `version` field) — it must NEVER throw and
 * crash boot, so resolution is wrapped and falls back to "0.0.0".
 */
function readAppVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require(join(process.cwd(), "package.json")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const APP_VERSION = readAppVersion();
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

async function spendByTenant(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(
    TRACKED_TENANTS.map(async (t) => {
      out[t] = await getTodayCostUsd(t).catch(() => -1); // -1 signals "DB unavailable"
    }),
  );
  return out;
}

export interface RagHealthCheck {
  /** "ok" = has rows; "empty" = table exists but 0 rows (the production outage class);
   *  "unavailable" = DB query failed */
  status: "ok" | "empty" | "unavailable";
  knowledge_entries: number;
  brain_vectors: number;
}

export interface HealthReport {
  status: "ok" | "degraded";
  version: string;
  uptime_s: number;
  checks: {
    database: "up" | "down";
    gmail_backend: string;
    gmail_active: "up" | "down" | "unconfigured";
    /** RAG store health: empty = brain:sync never ran (the 2026-06-15 prod outage class) */
    rag: RagHealthCheck;
  };
  integrations: {
    composio_gmail: { status: string; detail: string };
    gws_gmail: { status: string; detail: string };
    googleapis_gmail: { status: string; detail: string };
    active_gmail: { status: string; detail: string };
    checked_at: string | null;
  };
  spend_today_usd: Record<string, number>;
}

/** Query RAG store health — never throws (DB down → unavailable). */
async function pingRag(): Promise<RagHealthCheck> {
  try {
    const [ke, bv] = await Promise.all([
      getKnowledgeEntryCount("turicks"),
      getTuricksBrainCount(),
    ]);
    return {
      status: ke > 0 || bv > 0 ? "ok" : "empty",
      knowledge_entries: ke,
      brain_vectors: bv,
    };
  } catch {
    return { status: "unavailable", knowledge_entries: -1, brain_vectors: -1 };
  }
}

/** Build the health report (exported for testing without a socket). */
export async function buildHealthReport(): Promise<HealthReport> {
  const [db, spend, rag] = await Promise.all([pingDb(), spendByTenant(), pingRag()]);
  const probe =
    (await runProviderProbes().catch(() => null)) ?? getLastProviderProbe();
  const backend = probe?.gmail_backend ?? getGmailBackend();
  const composio = probe?.composio_gmail ?? { status: "unconfigured" as const, detail: "not probed" };
  const gws = probe?.gws_gmail ?? { status: "unconfigured" as const, detail: "not probed" };
  const googleapis = probe?.googleapis_gmail ?? { status: "unconfigured" as const, detail: "not probed" };
  const active = probe?.active_gmail ?? { status: "unconfigured" as const, detail: "not probed" };
  const gmailDegraded = active.status === "down";
  return {
    status: db && !gmailDegraded ? "ok" : "degraded",
    version: APP_VERSION,
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    checks: {
      database: db ? "up" : "down",
      gmail_backend: backend,
      gmail_active: active.status,
      rag,
    },
    integrations: {
      composio_gmail: composio,
      gws_gmail: gws,
      googleapis_gmail: googleapis,
      active_gmail: active,
      checked_at: probe?.checked_at ?? null,
    },
    spend_today_usd: spend,
  };
}

/**
 * Start the health server. Returns the node http.Server (call .close() to stop).
 */
export function startHealthServer(port = Number(process.env["HEALTH_PORT"] ?? 3001)): Server {
  const server = createServer((req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0] ?? "/";

    // CORS headers for local frontend dev
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && urlPath === "/health") {
      void buildHealthReport().then((report) => {
        const code = report.checks.database === "up" ? 200 : 503;
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(report));
      });
      return;
    }

    if (req.method === "GET" && urlPath === "/metrics") {
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

    // Two stub routes that must never claim work they did not do — see
    // src/infra/health-api-stubs.ts for what each one used to fabricate.
    if (req.method === "POST" && urlPath === "/api/v1/dispatch") {
      handleDispatch(req, res);
      return;
    }

    if (req.method === "POST" && urlPath === "/api/v1/hitl/respond") {
      handleHitlRespond(req, res);
      return;
    }

    if (req.method === "GET" && urlPath === "/api/v1/trace/history") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(recentTraceEvents));
      return;
    }

    if (req.method === "GET" && urlPath === "/api/v1/stats") {
      void buildHealthReport().then((report) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          version: report.version,
          uptime_s: report.uptime_s,
          database: report.checks.database,
          spend_today: report.spend_today_usd,
          rag: report.checks.rag,
          active_workers: 8,
          hitl_gated_tools: 17,
        }));
      });
      return;
    }

    if (req.method === "GET" && urlPath === "/api/v1/sse/trace") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write(`data: ${JSON.stringify({ type: "connected", timestamp: Date.now() })}\n\n`);
      sseClients.add(res);
      req.on("close", () => {
        sseClients.delete(res);
      });
      return;
    }

    if (req.method === "GET" && urlPath === "/api/v1/jobhunt/queue") {
      void getPgPool().query(`
        SELECT id, company, title, track, url, brief_rank, brief_section, tailored_cv_s3_key
        FROM agents.job_applications
        WHERE tenant_id = 'turicks'
          AND brief_section IN ('do_today','stretch')
          AND applied_at IS NULL
          AND skipped_at IS NULL
          AND url IS NOT NULL
        ORDER BY brief_rank
      `).then((resDb) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(resDb.rows));
      }).catch((err) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }

    if (req.method === "POST" && urlPath.startsWith("/api/v1/jobhunt/") && urlPath.endsWith("/skip")) {
      const id = urlPath.split("/")[4];
      if (id) {
        void getPgPool().query(
          "UPDATE agents.job_applications SET skipped_at = now(), updated_at = now() WHERE id = $1 AND skipped_at IS NULL", 
          [id]
        ).then(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "skipped" }));
        }).catch((err) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        });
        return;
      }
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  // Bind failure (e.g. EADDRINUSE during a fast restart, before the previous
  // instance released the port) must NOT kill the bot — the health/metrics port
  // is observability, not a core dependency. Log it and carry on; the previous
  // instance's exit frees the port shortly after.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.warn({ port }, "Health port in use — continuing without health server (non-fatal)");
    } else {
      log.warn({ port, err: err.message }, "Health server error (non-fatal)");
    }
  });

  server.listen(port, () => log.info({ port }, "Health server on /health, /metrics"));
  // Don't keep the event loop alive on this socket alone.
  server.unref();
  return server;
}
