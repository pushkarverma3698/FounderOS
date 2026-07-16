/**
 * FounderOS MCP Server — Streamable HTTP entry point (spec §1.2, item 6)
 * ======================================================================
 * The NETWORK ingress for the read-only MCP server. It exists so the Mac's MCP
 * clients (Claude Code / Desktop / the FounderOS bridge) can consume the VPS's
 * production data plane through an SSH local-forward — see docs/VPS-MCP-SETUP.md.
 *
 * The design is defense-in-depth on a private transport, in this order:
 *   1. Bind 127.0.0.1 only. The port never leaves loopback; the SSH tunnel
 *      (`ssh -N -L 3100:127.0.0.1:3100`) is the sole ingress. Binding a public
 *      address is refused unless FOUNDEROS_MCP_ALLOW_PUBLIC=1 (assertBindAllowed).
 *   2. Require `Authorization: Bearer $FOUNDEROS_MCP_TOKEN`, checked BEFORE any
 *      JSON-RPC parsing or tool dispatch (authorizeBearer → handler). Even inside
 *      the tunnel an unauthenticated request never reaches a tool.
 *   3. Expose only the read-only tool surface `buildMcpServer()` already defines
 *      (writes live solely behind the Telegram HITL flow — the topology adds
 *      reach, not privilege).
 *
 * The secret is an env-var NAME everywhere in the repo (FOUNDEROS_MCP_TOKEN);
 * its value is read from the environment at startup and never written to the
 * bridge manifest, logs, or receipts.
 *
 * Start: pnpm mcp:http  (entry: src/mcp/index-http.ts)
 * Generate a token: openssl rand -hex 32
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./server.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "mcp:http" });

/** Default loopback port for the MCP HTTP server (matches the SSH -L forward). */
export const DEFAULT_MCP_PORT = 3100;
/** Minimum acceptable token length — a short token is a misconfiguration, not a
 *  secret. `openssl rand -hex 32` yields 64 chars; we require at least 16. */
export const MIN_TOKEN_LENGTH = 16;

// ── Bearer authorization (pure) ─────────────────────────────────────────────

export type AuthResult = { ok: true } | { ok: false; status: number; message: string };

/**
 * Decide whether a request's Authorization header carries the expected bearer
 * token. Pure — no I/O — so the security boundary is unit-tested, not asserted.
 *
 * An empty `expected` is a server misconfiguration and returns 500 (fail loud,
 * never fail open): a server with no token must reject every request, not admit
 * all of them. The token comparison is length-guarded and constant-time to keep
 * a wrong-length or partial-prefix guess from leaking timing signal.
 */
export function authorizeBearer(header: string | undefined, expected: string): AuthResult {
  if (!expected) return { ok: false, status: 500, message: "server misconfigured: no FOUNDEROS_MCP_TOKEN" };
  if (!header) return { ok: false, status: 401, message: "missing Authorization header" };
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return { ok: false, status: 401, message: "expected 'Authorization: Bearer <token>'" };
  const got = Buffer.from(match[1]!, "utf8");
  const want = Buffer.from(expected, "utf8");
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    return { ok: false, status: 401, message: "invalid token" };
  }
  return { ok: true };
}

// ── Loopback bind guard (pure) ──────────────────────────────────────────────

/** True for addresses that never leave the local machine. `127.0.0.0/8` is all
 *  loopback, so any `127.*` counts alongside `::1` and the `localhost` alias. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "::1" || h === "127.0.0.1" || h.startsWith("127.");
}

/**
 * Throw unless it is safe to bind `host`. The server is designed to sit behind
 * an SSH tunnel on loopback; a public bind is a foot-gun that exposes the data
 * plane, so it requires the explicit FOUNDEROS_MCP_ALLOW_PUBLIC=1 override.
 */
export function assertBindAllowed(host: string, allowPublic: boolean): void {
  if (!isLoopbackHost(host) && !allowPublic) {
    throw new Error(
      `refusing to bind the MCP HTTP server to non-loopback host "${host}". ` +
        `It is meant to sit behind an SSH tunnel on 127.0.0.1. ` +
        `Set FOUNDEROS_MCP_ALLOW_PUBLIC=1 to override (NOT recommended — the ` +
        `bearer token becomes your only control).`,
    );
  }
}

// ── HTTP server factory ─────────────────────────────────────────────────────

/** A request handler that runs only AFTER authorization has passed. */
export type McpDispatch = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export interface McpHttpServerOptions {
  /** The expected bearer token (value, not name). Required and non-empty. */
  token: string;
  /** Runs the MCP transport once auth passes. Injectable for tests; defaults to
   *  a per-request Streamable HTTP transport over `buildMcpServer()`. */
  dispatch?: McpDispatch;
}

/** Default dispatch: a fresh stateless Streamable HTTP transport per request.
 *  Per-request construction is the SDK's documented stateless pattern and is
 *  correct for the founder's low-volume, single-client usage; both the server
 *  and transport are torn down when the response closes. */
async function defaultDispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

function writeJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Build (but do not start) the MCP HTTP server. The returned `http.Server` has
 * no address bound — the caller decides host/port so the loopback guard and the
 * ephemeral-port test both drive the exact same handler.
 *
 * Request flow: `/healthz` answers liveness without auth or dispatch (nothing
 * sensitive leaks); every other path is bearer-checked, and only an authorized
 * request is handed to `dispatch`.
 */
export function createMcpHttpServer(opts: McpHttpServerOptions): Server {
  const dispatch = opts.dispatch ?? defaultDispatch;

  return createServer((req, res) => {
    const url = req.url ?? "/";

    // Unauthenticated liveness probe for systemd/the tunnel — returns no data.
    if (req.method === "GET" && (url === "/healthz" || url.startsWith("/healthz?"))) {
      writeJson(res, 200, { status: "ok" });
      return;
    }

    // Auth BEFORE dispatch — an unauthorized request never reaches a tool.
    const auth = authorizeBearer(req.headers["authorization"], opts.token);
    if (!auth.ok) {
      writeJson(
        res,
        auth.status,
        { jsonrpc: "2.0", error: { code: -32001, message: `Unauthorized: ${auth.message}` }, id: null },
        auth.status === 401 ? { "www-authenticate": "Bearer" } : {},
      );
      return;
    }

    void dispatch(req, res).catch((err: unknown) => {
      log.error({ err: (err as Error).message }, "MCP HTTP dispatch failed");
      if (!res.headersSent) {
        writeJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
      }
    });
  });
}

// ── Startup (reads env; side-effecting) ─────────────────────────────────────

/** Parse FOUNDEROS_MCP_PORT, falling back to the default for unset/garbage. */
function resolvePort(): number {
  const n = Number(process.env["FOUNDEROS_MCP_PORT"]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MCP_PORT;
}

/**
 * Read config from the environment, enforce the security invariants, and start
 * listening. Throws (fail loud) if the token is unset/too short or the requested
 * bind is public without the explicit override — the process must not come up in
 * an insecure state. Returns the listening server.
 */
export function startMcpHttpServer(): Server {
  const token = process.env["FOUNDEROS_MCP_TOKEN"] ?? "";
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `FOUNDEROS_MCP_TOKEN must be set to at least ${MIN_TOKEN_LENGTH} characters before starting the MCP HTTP server. ` +
        `Generate one with: openssl rand -hex 32`,
    );
  }
  const host = process.env["FOUNDEROS_MCP_HOST"]?.trim() || "127.0.0.1";
  const allowPublic = process.env["FOUNDEROS_MCP_ALLOW_PUBLIC"] === "1";
  assertBindAllowed(host, allowPublic);

  const port = resolvePort();
  const server = createMcpHttpServer({ token });
  server.listen(port, host, () => {
    log.info(
      { host, port, allowPublic, tools: 6 },
      allowPublic && !isLoopbackHost(host)
        ? "FounderOS MCP HTTP server listening (PUBLIC bind — bearer token is the only control)"
        : "FounderOS MCP HTTP server listening (loopback; reach via SSH -L tunnel)",
    );
  });
  return server;
}
