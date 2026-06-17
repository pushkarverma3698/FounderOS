/**
 * FounderOS — Web Gateway (JARVIS / MISO API)
 * ============================================
 * REST + SSE endpoints for the web frontend. Reuses the same office run-loop
 * as Telegram via GatewaySession (ADR-007).
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TENANT } from "../core/config.js";
import {
  createMission,
  closeMission,
  getActiveMission,
  getMissionById,
  getInterruptById,
  listMissions,
  getRecentAuditEntries,
} from "../db/queries.js";
import { runOfficeSession, resumeOfficeSession } from "./office-run.js";
import { createWebSession } from "./session.js";
import { subscribeStreamEvents } from "./stream-hub.js";
import { formatMisoDashboard, formatMisoClose, missionToView } from "./mission-control.js";
import { getOffice, getPendingApproval } from "../agents/office.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "web-gateway" });

function webToken(): string | undefined {
  return process.env["WEB_GATEWAY_TOKEN"]?.trim() || undefined;
}

function authOk(authHeader: string | undefined): boolean {
  const token = webToken();
  if (!token) return true;
  if (!authHeader?.startsWith("Bearer ")) return false;
  return authHeader.slice(7) === token;
}

export function createWebApp(): Hono {
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    if (!authOk(c.req.header("authorization"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/api/v1/health", (c) => c.json({ ok: true, transport: "web" }));

  app.post("/api/v1/sessions/:id/messages", async (c) => {
    const sessionId = c.req.param("id");
    const body = await c.req.json<{ text?: string }>().catch(() => ({ text: "" }));
    const text = body.text?.trim() ?? "";
    if (!text) return c.json({ error: "text_required" }, 400);

    const session = createWebSession(sessionId);
    void runOfficeSession(session, text).catch((err) =>
      log.error({ sessionId, err: (err as Error).message }, "Web office run failed"),
    );
    return c.json({ accepted: true, sessionId });
  });

  app.get("/api/v1/sessions/:id/stream", (c) => {
    const sessionId = c.req.param("id");
    return streamSSE(c, async (stream) => {
      const unsub = subscribeStreamEvents(sessionId, (ev) => {
        void stream.writeSSE({ data: JSON.stringify(ev), event: ev.type });
      });
      try {
        await stream.sleep(60 * 60 * 1000);
      } finally {
        unsub();
      }
    });
  });

  app.post("/api/v1/sessions/:id/hitl/:decision", async (c) => {
    const sessionId = c.req.param("id");
    const decision = c.req.param("decision");
    if (decision !== "approve" && decision !== "reject") {
      return c.json({ error: "invalid_decision" }, 400);
    }
    const session = createWebSession(sessionId);
    await resumeOfficeSession(session, decision === "approve" ? "approved" : "rejected");
    return c.json({ ok: true, decision });
  });

  app.post("/api/v1/hitl/:interruptId/approve", async (c) => {
    const interruptId = c.req.param("interruptId");
    const row = await getInterruptById(interruptId);
    if (!row) return c.json({ error: "not_found" }, 404);
    const sessionId = row.thread_id.split(":").slice(1).join(":") || row.thread_id;
    await resumeOfficeSession(createWebSession(sessionId), "approved");
    return c.json({ ok: true });
  });

  app.post("/api/v1/hitl/:interruptId/reject", async (c) => {
    const interruptId = c.req.param("interruptId");
    const row = await getInterruptById(interruptId);
    if (!row) return c.json({ error: "not_found" }, 404);
    const sessionId = row.thread_id.split(":").slice(1).join(":") || row.thread_id;
    await resumeOfficeSession(createWebSession(sessionId), "rejected");
    return c.json({ ok: true });
  });

  app.get("/api/v1/missions", async (c) => {
    const rows = await listMissions(TENANT, 50);
    return c.json({
      missions: rows.map((r) => ({
        ...missionToView(r),
        dashboard: formatMisoDashboard(missionToView(r)),
      })),
    });
  });

  app.post("/api/v1/sessions/:id/missions", async (c) => {
    const sessionId = c.req.param("id");
    const body = await c.req.json<{ goal?: string; owner?: string; issueRef?: string }>();
    const goal = body.goal?.trim();
    if (!goal) return c.json({ error: "goal_required" }, 400);

    const missionId = await createMission({
      session_id: sessionId,
      thread_id: `${TENANT}:${sessionId}`,
      goal,
      owner: body.owner ?? "founder",
      issue_ref: body.issueRef,
      phase: "INIT",
      next_action: "awaiting first message",
    });
    const row = await getMissionById(missionId);
    return c.json({
      missionId,
      dashboard: row ? formatMisoDashboard(missionToView(row)) : null,
    });
  });

  app.get("/api/v1/audit", async (c) => {
    const entries = await getRecentAuditEntries(TENANT, 50);
    return c.json({ entries });
  });

  return app;
}

let _webApp: Hono | undefined;

function getWebApp(): Hono {
  if (!_webApp) _webApp = createWebApp();
  return _webApp;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Handle a single HTTP request for /api/* routes (mounted from health server). */
export async function handleWebGatewayRequest(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
): Promise<boolean> {
  const urlPath = (req.url ?? "/").split("?")[0] ?? "/";
  if (!urlPath.startsWith("/api/")) return false;

  const bodyBuf =
    req.method !== "GET" && req.method !== "HEAD" ? await readBody(req) : undefined;
  const request = new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: bodyBuf?.length ? bodyBuf : undefined,
  });

  const response = await getWebApp().fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
  return true;
}

export async function buildMisoStatus(sessionId: string): Promise<string> {
  const mission = await getActiveMission(sessionId);
  const office = await getOffice();
  const config = { configurable: { thread_id: `${TENANT}:${sessionId}` } };
  const pending = await getPendingApproval(office, config);

  const lines = ["🤖 MISO Status", "——————————————"];
  if (mission) {
    lines.push(formatMisoDashboard(missionToView(mission)));
  } else {
    lines.push("No active mission. Use /miso_start <goal> to open one.");
  }
  if (pending) {
    lines.push("", `⏸ Pending HITL: ${pending.title}`);
  }
  lines.push("——————————————");
  return lines.join("\n");
}

export async function closeActiveMission(sessionId: string): Promise<string | null> {
  const mission = await getActiveMission(sessionId);
  if (!mission) return null;
  await closeMission(mission.mission_id, "COMPLETE");
  return formatMisoClose({
    implemented: mission.goal,
    validation: "manual close via /miso_close",
    changes: mission.department ?? "n/a",
    risks: mission.risk ?? "none",
  });
}
