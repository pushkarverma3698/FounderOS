/**
 * FounderOS hub — Streamable HTTP entry point (see hub-server.ts for what it serves).
 * ==================================================================================
 * hub.ts (stdio over SSH) stays the way laptop tools connect. This entry is for
 * clients that cannot start a process over SSH: an OpenDots Connection (Streamable
 * HTTP + bearer token only) and the OpenDots computers. The July HTTP server was
 * removed (f35f4be9) because SSH covered every client then; these do not fit it.
 *
 *   HUB_HTTP_TOKEN        bearer for scope "all"   (brain + Gmail/Calendar reads + connected servers)
 *   HUB_HTTP_BRAIN_TOKEN  bearer for scope "brain" (brain only: the computers run repo code as
 *                         root, so whatever token they hold must not read the founder's mail)
 *   HUB_HTTP_HOST         default 127.0.0.1; loopback or a private address only (on the VPS: the
 *                         opendots-computers bridge gateway, so only that Docker network reaches it)
 *   HUB_HTTP_PORT         default 3100
 *
 * The token picks the scope before any JSON-RPC is read; a request without a known
 * token gets 401 and never reaches a tool. Stateless: one server and transport per
 * request, as the SDK documents for this pattern.
 *
 * Run: node --env-file=.env --import tsx/esm src/mcp/hub-http.ts (deploy/founderos-hub-http.service)
 */

import { createServer, type Server } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { logger } from "../infra/logger.js";
import { buildHubServer, type HubScope } from "./hub-server.js";
import { closeBridgeConnections } from "./hub-bridge.js";

const log = logger.child({ module: "mcp-hub-http" });

export const MIN_TOKEN_LENGTH = 32;

export interface HubHttpConfig {
  host: string;
  port: number;
  tokens: Array<{ token: string; scope: HubScope }>;
}

/** Loopback or RFC 1918. Anything else (0.0.0.0, a public IP, a name) is refused. */
function isPrivateHost(host: string): boolean {
  if (host === "::1" || host === "localhost") return true;
  if (isIP(host) !== 4) return false;
  const [a, b] = host.split(".").map(Number) as [number, number];
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function readHubHttpConfig(env: Record<string, string | undefined>): HubHttpConfig {
  const host = env["HUB_HTTP_HOST"]?.trim() || "127.0.0.1";
  if (!isPrivateHost(host)) {
    throw new Error(`HUB_HTTP_HOST must be a loopback or private address; got "${host}".`);
  }
  const port = Number(env["HUB_HTTP_PORT"]?.trim() || "3100");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`HUB_HTTP_PORT is not a port: "${env["HUB_HTTP_PORT"]}".`);

  const tokens: HubHttpConfig["tokens"] = [];
  for (const [name, scope] of [["HUB_HTTP_TOKEN", "all"], ["HUB_HTTP_BRAIN_TOKEN", "brain"]] as const) {
    const token = env[name]?.trim();
    if (!token) continue;
    if (token.length < MIN_TOKEN_LENGTH) throw new Error(`${name} must be at least ${MIN_TOKEN_LENGTH} characters (openssl rand -hex 32).`);
    tokens.push({ token, scope });
  }
  if (tokens.length === 0) throw new Error("Set HUB_HTTP_TOKEN and/or HUB_HTTP_BRAIN_TOKEN.");
  if (tokens.length === 2 && tokens[0]!.token === tokens[1]!.token) {
    throw new Error("HUB_HTTP_TOKEN and HUB_HTTP_BRAIN_TOKEN must differ: the token decides the scope.");
  }
  return { host, port, tokens };
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** The scope of the bearer token in `header`, or null. Constant-time per token. */
export function scopeForAuthorization(header: string | undefined, tokens: HubHttpConfig["tokens"]): HubScope | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? "");
  if (!match) return null;
  const got = digest(match[1]!);
  let scope: HubScope | null = null;
  for (const t of tokens) if (timingSafeEqual(got, digest(t.token))) scope = t.scope;
  return scope;
}

export function createHubHttpServer(cfg: HubHttpConfig): Server {
  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
      return;
    }
    if (path !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    const scope = scopeForAuthorization(req.headers["authorization"], cfg.tokens);
    if (!scope) {
      log.warn({ remote: req.socket.remoteAddress }, "hub-http: rejected request without a known bearer token");
      res.writeHead(401, { "www-authenticate": "Bearer", "content-type": "application/json" }).end('{"error":"unauthorized"}');
      return;
    }
    const server = buildHubServer({ scope });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch((err: unknown) => {
        log.error({ err, scope }, "hub-http: request failed");
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end('{"error":"internal"}');
      });
  });
}

export async function runHubHttp(cfg: HubHttpConfig): Promise<Server> {
  const http = createHubHttpServer(cfg);
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(cfg.port, cfg.host, resolve);
  });
  log.info({ host: cfg.host, port: cfg.port, scopes: cfg.tokens.map((t) => t.scope) }, "FounderOS hub started (http)");
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    http.close();
    await closeBridgeConnections();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return http;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  Promise.resolve()
    .then(() => runHubHttp(readHubHttpConfig(process.env)))
    .catch((err) => {
      console.error("FounderOS hub (http) failed to start:", err);
      process.exit(1);
    });
}
