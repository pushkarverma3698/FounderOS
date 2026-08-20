/**
 * Health server — the two API routes that do NOT do what their name says.
 * ========================================================================
 * Extracted from health.ts so the lie each one used to tell can be documented
 * at full length without pushing that file past the 400-line budget.
 *
 * Both handlers reported work that never happened, and — worse — both wrote
 * that fiction into the trace log. journald is the corroboration channel
 * `pnpm verify:benchmark` (scripts/verify-benchmark-run.ts) reads to prove a
 * benchmark turn really occurred, so an endpoint that mints trace records for
 * turns it never ran can manufacture evidence for a run nobody performed.
 *
 * The rule both now obey: an endpoint that did not do the work must not claim
 * it did, and must leave no trace saying it did.
 *
 * NOTE: `startTurn` is deliberately never imported here. Nothing in this file
 * runs a real turn, so nothing in it may mint a trace turnId.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { childLogger } from "./logger.js";

const log = childLogger({ module: "health-api-stubs" });

/** Read a JSON request body, then hand it to `onBody`. Malformed JSON → 400. */
function withJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  onBody: (body: Record<string, unknown>) => void,
): void {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    try {
      onBody(JSON.parse(raw || "{}") as Record<string, unknown>);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_json" }));
    }
  });
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * POST /api/v1/dispatch — a prompt box for scripts/tui-dashboard.ts.
 *
 * It has NEVER invoked the kernel. It minted a trace turnId and emitted a
 * hardcoded script — `route.decided: engineering`, then on a `setTimeout`
 * `tool.call: "pnpm gate"`, `tool.result: "pnpm gate passed"`, `turn.out:
 * completed` — and returned that turnId as though a turn had run. Every one of
 * those events reached journald.
 *
 * Now OFF by default, and even when enabled it emits no trace events at all and
 * states in its own response body that the kernel was not invoked.
 */
export function handleDispatch(req: IncomingMessage, res: ServerResponse): void {
  if (process.env["TUI_DISPATCH_ENABLED"] !== "true") {
    send(res, 404, {
      error: "not_enabled",
      detail:
        "/api/v1/dispatch is a TUI demo stub that does not invoke the kernel. Set TUI_DISPATCH_ENABLED=true to enable it. It never runs a real turn.",
    });
    return;
  }

  withJsonBody(req, res, (body) => {
    const prompt = String(body["prompt"] ?? "").trim();
    if (!prompt) {
      send(res, 400, { error: "prompt_required" });
      return;
    }

    log.info({ promptPreview: prompt.slice(0, 60) }, "TUI dispatch stub accepted a prompt (no kernel run)");
    send(res, 200, { status: "accepted", synthetic: true, kernel_invoked: false, prompt });
  });
}

/**
 * POST /api/v1/hitl/respond — approve or reject a pending HITL request.
 *
 * It did NOTHING: no approval row read or written, no kernel resume, no side
 * effect. It returned `{status:"success"}` and wrote a `hitl.resume` seam event.
 * Two lies from one handler — the Jarvis web UI
 * (apps/jarvis-next/src/App.tsx:189) showed a successful approval for an
 * authorization that never happened, and the trace log recorded that
 * authorization as fact, against the standing rule that an audit row is written
 * only on real success.
 *
 * 501 until a real resume path exists. A visibly broken approve button is
 * strictly safer than one that reports success over a live side effect, and the
 * response names the path that does work so the founder is never stranded.
 */
export function handleHitlRespond(req: IncomingMessage, res: ServerResponse): void {
  withJsonBody(req, res, (body) => {
    const id = body["id"];
    const action = body["action"];
    if (!id || !action) {
      send(res, 400, { error: "id_and_action_required" });
      return;
    }

    log.warn(
      { hitlId: id, action },
      "HITL respond called over HTTP — NOT IMPLEMENTED, nothing was approved or rejected",
    );

    send(res, 501, {
      error: "not_implemented",
      approved: false,
      detail:
        "HITL cannot be resolved over HTTP: this endpoint has no resume path and performs no side effect. Nothing was approved or rejected. Use the Approve/Reject buttons on the Telegram card.",
      hitlId: id,
      action,
    });
  });
}
