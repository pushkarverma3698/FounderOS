/**
 * Live smoke — JARVIS production path (static + API + SSE auth)
 *
 *   node --env-file=.env --import tsx/esm scripts/smoke-jarvis-e2e.ts
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getPgPool } from "../src/db/client.js";
import { createWebApp } from "../src/gateway/web.js";
import { startHealthServer } from "../src/infra/health.js";
import { publishStreamEvent, resetStreamHubs } from "../src/gateway/stream-hub.js";

const PORT = Number(process.env["SMOKE_JARVIS_PORT"] ?? 3998);
const SESSION = "smoke-jarvis-e2e";

let failures = 0;

function pass(label: string, detail?: string): void {
  console.log(`[smoke-jarvis] ✅ ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label: string, detail: string): void {
  failures++;
  console.error(`[smoke-jarvis] ❌ ${label} — ${detail}`);
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

async function main(): Promise<void> {
  console.log("[smoke-jarvis] Starting JARVIS e2e smoke…");

  try {
    await getPgPool().query("SELECT 1");
    pass("Postgres ping");
  } catch (err) {
    fail("Postgres ping", (err as Error).message);
    process.exit(1);
  }

  const tmpDist = mkdtempSync(join(tmpdir(), "jarvis-dist-"));
  writeFileSync(join(tmpDist, "index.html"), "<!DOCTYPE html><html><body>JARVIS SPA</body></html>");
  process.env["JARVIS_DIST_ROOT"] = tmpDist;

  let healthServer: Server | undefined;
  const healthPort = PORT + 1;
  try {
    healthServer = startHealthServer(healthPort);
    await new Promise((r) => setTimeout(r, 150));

    const spa = await fetch(`http://127.0.0.1:${healthPort}/`);
    if (spa.status === 200 && (await spa.text()).includes("JARVIS SPA")) {
      pass("GET / serves JARVIS SPA");
    } else {
      fail("GET / SPA", String(spa.status));
    }

    const api = await fetch(`http://127.0.0.1:${healthPort}/api/v1/health`);
    if (api.status === 200) pass("GET /api/v1/health via health server");
    else fail("GET /api/v1/health", String(api.status));
  } finally {
    healthServer?.close();
  }

  resetStreamHubs();
  const app = createWebApp();
  const server = await startTestServer(app);

  try {
    const prev = process.env["WEB_GATEWAY_TOKEN"];
    process.env["WEB_GATEWAY_TOKEN"] = "jarvis-smoke-token";

    const deny = await app.request(`http://localhost/api/v1/sessions/${SESSION}/stream`);
    const allow = await app.request(
      `http://localhost/api/v1/sessions/${SESSION}/stream?token=jarvis-smoke-token`,
    );
    if (deny.status === 401 && allow.status === 200) pass("SSE query-token auth");
    else fail("SSE auth", `deny=${deny.status} allow=${allow.status}`);

    const accept = await app.request(`http://localhost/api/v1/sessions/${SESSION}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer jarvis-smoke-token" },
      body: JSON.stringify({ text: "smoke ping" }),
    });
    if (accept.status === 200) pass("POST /messages with Bearer auth");
    else fail("POST /messages", String(accept.status));

    publishStreamEvent(SESSION, { type: "mission.updated", data: { smoke: true } });
    pass("SSE pub/sub publish (in-process)");

    if (prev) process.env["WEB_GATEWAY_TOKEN"] = prev;
    else delete process.env["WEB_GATEWAY_TOKEN"];
  } finally {
    server.close();
    delete process.env["JARVIS_DIST_ROOT"];
    rmSync(tmpDist, { recursive: true, force: true });
  }

  console.log("");
  if (failures === 0) {
    console.log("[smoke-jarvis] ✅ ALL CHECKS PASSED");
    process.exit(0);
  } else {
    console.error(`[smoke-jarvis] ❌ FAIL — ${failures} check(s) failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[smoke-jarvis] FATAL", err);
  process.exit(1);
});
