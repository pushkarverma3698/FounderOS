/**
 * Live smoke — MISO + JARVIS web gateway
 * =======================================
 * Exercises real Postgres + HTTP server (no mocks).
 *
 *   node --env-file=.env --import tsx/esm scripts/smoke-miso-jarvis.ts
 */

import { createServer, type Server } from "node:http";
import { getPgPool } from "../src/db/client.js";
import { createWebApp } from "../src/gateway/web.js";
import { buildMisoStatus, closeActiveMission } from "../src/gateway/web.js";
import {
  createMission,
  getActiveMission,
  getMissionById,
  listMissions,
} from "../src/db/queries.js";
import {
  formatMisoDashboard,
  formatMisoPlan,
  missionToView,
} from "../src/gateway/mission-control.js";
import { publishStreamEvent, subscribeStreamEvents, resetStreamHubs } from "../src/gateway/stream-hub.js";
import { TENANT } from "../src/core/config.js";

const PORT = Number(process.env["SMOKE_PORT"] ?? 3999);
const SESSION = "smoke-miso-jarvis";

let failures = 0;

function pass(label: string, detail?: string): void {
  console.log(`[smoke-miso] ✅ ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label: string, detail: string): void {
  failures++;
  console.error(`[smoke-miso] ❌ ${label} — ${detail}`);
}

async function readBody(req: import("node:http").IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function startTestServer(app: ReturnType<typeof createWebApp>): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = (req.url ?? "/").split("?")[0] ?? "/";
      if (url.startsWith("/api/")) {
        const bodyBuf =
          req.method !== "GET" && req.method !== "HEAD" ? await readBody(req) : undefined;
        const request = new Request(`http://127.0.0.1:${PORT}${req.url ?? "/"}`, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: bodyBuf?.length ? bodyBuf : undefined,
        });
        const response = await app.fetch(request);
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
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    server.listen(PORT, () => resolve(server));
  });
}

async function httpJson(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain text */
  }
  return { status: res.status, body };
}

async function main(): Promise<void> {
  console.log("[smoke-miso] Starting live MISO + JARVIS smoke…");

  // 1. Postgres + missions table
  try {
    await getPgPool().query("SELECT 1");
    pass("Postgres ping");
  } catch (err) {
    fail("Postgres ping", (err as Error).message);
    process.exit(1);
  }

  try {
    const { rows } = await getPgPool().query(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'agents' AND table_name = 'missions'`,
    );
    if ((rows[0] as { n: number }).n === 1) {
      pass("missions table exists");
    } else {
      fail("missions table exists", "run pnpm run setup");
    }
  } catch (err) {
    fail("missions table check", (err as Error).message);
  }

  // 2. MISO formatting (pure)
  const dash = formatMisoDashboard(
    missionToView({
      mission_id: "00000000-0000-0000-0000-000000000001",
      tenant_id: TENANT,
      session_id: SESSION,
      thread_id: `${TENANT}:${SESSION}`,
      owner: "smoke",
      issue_ref: "1",
      goal: "Live smoke test mission",
      scope: null,
      completion_criteria: null,
      risk: "low",
      phase: "RUNNING",
      department: "research",
      next_action: "verify endpoints",
      agent_statuses: { research: "active" },
      telegram_msg_id: null,
      turn_id: null,
      started_at: new Date(),
      completed_at: null,
      created_at: new Date(),
    }),
  );
  if (dash.includes("MISSION CONTROL") && dash.includes("Live smoke test mission")) {
    pass("MISO dashboard format");
  } else {
    fail("MISO dashboard format", "missing required frames");
  }

  const plan = formatMisoPlan("Smoke goal");
  if (plan.includes("Execution plan")) pass("MISO plan format");
  else fail("MISO plan format", "missing plan header");

  // 3. DB mission CRUD
  const existing = await getActiveMission(SESSION);
  if (existing) {
    await closeActiveMission(SESSION);
    pass("cleared prior smoke mission");
  }

  const missionId = await createMission({
    tenant_id: TENANT,
    session_id: SESSION,
    thread_id: `${TENANT}:${SESSION}`,
    goal: "Live smoke test mission",
    owner: "smoke-runner",
    phase: "INIT",
    next_action: "HTTP probe",
  });
  const row = await getMissionById(missionId);
  if (row?.goal === "Live smoke test mission") pass("createMission + getMissionById", missionId.slice(0, 8));
  else fail("createMission", "row mismatch");

  const statusText = await buildMisoStatus(SESSION);
  if (statusText.includes("MISSION CONTROL") || statusText.includes("smoke test")) {
    pass("buildMisoStatus");
  } else {
    fail("buildMisoStatus", statusText.slice(0, 80));
  }

  // 4. SSE pub/sub
  resetStreamHubs();
  const received: string[] = [];
  const unsub = subscribeStreamEvents(SESSION, (ev) => received.push(ev.type));
  publishStreamEvent(SESSION, { type: "mission.updated", data: { smoke: true } });
  unsub();
  if (received.includes("mission.updated")) pass("SSE stream-hub publish/subscribe");
  else fail("SSE stream-hub", `got: ${received.join(",")}`);

  // 5. HTTP gateway (real server)
  const app = createWebApp();
  const server = await startTestServer(app);

  try {
    const health = await httpJson("/api/v1/health");
    if (health.status === 200 && (health.body as { ok?: boolean }).ok) {
      pass("GET /api/v1/health", String(health.status));
    } else {
      fail("GET /api/v1/health", JSON.stringify(health));
    }

    const missionsBefore = await httpJson("/api/v1/missions");
    if (missionsBefore.status === 200) {
      const list = (missionsBefore.body as { missions?: unknown[] }).missions ?? [];
      pass("GET /api/v1/missions", `${list.length} row(s)`);
    } else {
      fail("GET /api/v1/missions", String(missionsBefore.status));
    }

    const audit = await httpJson("/api/v1/audit");
    if (audit.status === 200) pass("GET /api/v1/audit");
    else fail("GET /api/v1/audit", String(audit.status));

    const createViaApi = await httpJson(`/api/v1/sessions/${SESSION}-api/missions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "API-created smoke mission" }),
    });
    if (createViaApi.status === 200 && (createViaApi.body as { missionId?: string }).missionId) {
      pass("POST /api/v1/sessions/:id/missions");
    } else {
      fail("POST missions", JSON.stringify(createViaApi));
    }

    const badMsg = await httpJson(`/api/v1/sessions/${SESSION}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "  " }),
    });
    if (badMsg.status === 400) pass("POST /messages rejects empty text");
    else fail("POST /messages validation", String(badMsg.status));

    // Accept message (async office run — we only verify 202/200 accept, not full LLM)
    const accept = await httpJson(`/api/v1/sessions/${SESSION}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "ping — smoke test only, reply with one word: ok" }),
    });
    if (accept.status === 200 && (accept.body as { accepted?: boolean }).accepted) {
      pass("POST /messages accepted (office runs async)");
    } else {
      fail("POST /messages accept", JSON.stringify(accept));
    }

    const misoStatus = await httpJson(`/api/v1/sessions/${SESSION}/miso/status`);
    if (misoStatus.status === 200 && (misoStatus.body as { status?: string }).status) {
      pass("GET /api/v1/sessions/:id/miso/status");
    } else {
      fail("GET miso/status", JSON.stringify(misoStatus));
    }

    const misoPlan = await httpJson(`/api/v1/sessions/${SESSION}/miso/plan`);
    if (misoPlan.status === 200 || misoPlan.status === 404) {
      pass("GET /api/v1/sessions/:id/miso/plan", String(misoPlan.status));
    } else {
      fail("GET miso/plan", String(misoPlan.status));
    }

    const misoClose = await httpJson(`/api/v1/sessions/${SESSION}/miso/close`, { method: "POST" });
    if (misoClose.status === 200 || misoClose.status === 404) {
      pass("POST /api/v1/sessions/:id/miso/close", String(misoClose.status));
    } else {
      fail("POST miso/close", String(misoClose.status));
    }

    // Token auth gate (set env after open-route checks — authOk reads env per request)
    const prev = process.env["WEB_GATEWAY_TOKEN"];
    process.env["WEB_GATEWAY_TOKEN"] = "smoke-secret";
    // Recreate app with auth — need fresh import; test via direct fetch to new server is heavy.
    // Instead verify auth logic on a one-off request with wrong token by spinning short-lived handler.
    const authedApp = createWebApp();
    const deny = await authedApp.request("http://localhost/api/v1/missions");
    const allow = await authedApp.request("http://localhost/api/v1/missions", {
      headers: { authorization: "Bearer smoke-secret" },
    });
    if (deny.status === 401 && allow.status === 200) pass("WEB_GATEWAY_TOKEN auth gate");
    else fail("WEB_GATEWAY_TOKEN auth", `deny=${deny.status} allow=${allow.status}`);

    const queryAuth = await authedApp.request(
      "http://localhost/api/v1/sessions/test/stream?token=smoke-secret",
    );
    if (queryAuth.status === 200) pass("WEB_GATEWAY_TOKEN query auth for SSE");
    else fail("WEB_GATEWAY_TOKEN query auth", String(queryAuth.status));

    if (prev) process.env["WEB_GATEWAY_TOKEN"] = prev;
    else delete process.env["WEB_GATEWAY_TOKEN"];

    await closeActiveMission(SESSION);
    await closeActiveMission(`${SESSION}-api`);
    pass("cleanup smoke missions");
  } finally {
    server.close();
  }

  const listed = await listMissions(TENANT, 5);
  pass("listMissions", `${listed.length} recent`);

  console.log("");
  if (failures === 0) {
    console.log("[smoke-miso] ✅ ALL LIVE CHECKS PASSED");
    process.exit(0);
  } else {
    console.error(`[smoke-miso] ❌ FAIL — ${failures} check(s) failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[smoke-miso] FATAL", err);
  process.exit(1);
});
