/**
 * Health server — the API must not write fiction into the trace log.
 * ===================================================================
 * Two handlers reported work that never happened, and both wrote that fiction
 * to journald — the same log `pnpm verify:benchmark` reads to prove a benchmark
 * turn really occurred (scripts/verify-benchmark-run.ts).
 *
 *  - POST /api/v1/dispatch minted a real trace turnId and emitted a hardcoded
 *    script (route.decided: engineering, tool.call: "pnpm gate", tool.result:
 *    "pnpm gate passed") on a setTimeout, without ever invoking the kernel.
 *  - POST /api/v1/hitl/respond returned {status:"success"} and wrote a
 *    `hitl.resume` seam for an approval it never performed — no row read, no
 *    resume, no side effect. The Jarvis web UI's approve button called it.
 *
 * The invariant these pin: an endpoint that did not do the work must not claim
 * it did, and must leave no trace saying it did.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { Server } from "node:http";

vi.mock("../../../src/infra/provider-probes.js", () => ({
  runProviderProbes: vi.fn().mockRejectedValue(new Error("skip in tests")),
  getLastProviderProbe: vi.fn().mockReturnValue(null),
}));

import { startHealthServer } from "../../../src/infra/health.js";
import { setTraceSink } from "../../../src/infra/trace.js";
import type { TraceEvent } from "../../../src/infra/trace.js";

const realFetch = (globalThis as { __realFetch?: typeof fetch }).__realFetch;
if (realFetch) vi.stubGlobal("fetch", realFetch);

let server: Server | undefined;
let emitted: TraceEvent[];

function awaitListening(s: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (s.listening) return resolve();
    s.once("listening", () => resolve());
    s.once("error", reject);
  });
}

/** Start on an ephemeral port and return it, capturing every trace event emitted. */
async function start(): Promise<number> {
  server = startHealthServer(0);
  await awaitListening(server);
  return (server.address() as { port: number }).port;
}

async function post(port: number, path: string, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  emitted = [];
  setTraceSink((ev) => emitted.push(ev));
  delete process.env["TUI_DISPATCH_ENABLED"];
});

afterEach(() => {
  setTraceSink(null);
  server?.close();
  server = undefined;
});

describe("POST /api/v1/dispatch — the demo stub is off by default", () => {
  it("404s when TUI_DISPATCH_ENABLED is unset, and says why", async () => {
    const port = await start();

    const res = await post(port, "/api/v1/dispatch", { prompt: "run the gate" });

    expect(res.status).toBe(404);
    expect(res.body["error"]).toBe("not_enabled");
    expect(String(res.body["detail"])).toContain("does not invoke the kernel");
  });

  it("emits NO trace events when disabled", async () => {
    const port = await start();

    await post(port, "/api/v1/dispatch", { prompt: "run the gate" });

    expect(emitted).toEqual([]);
  });

  it("when enabled, still emits no trace events and admits the kernel never ran", async () => {
    process.env["TUI_DISPATCH_ENABLED"] = "true";
    const port = await start();

    const res = await post(port, "/api/v1/dispatch", { prompt: "run the gate" });

    expect(res.status).toBe(200);
    expect(res.body["synthetic"]).toBe(true);
    expect(res.body["kernel_invoked"]).toBe(false);
    // The forgery: a turnId in journald that no real turn ever produced.
    expect(res.body["turnId"]).toBeUndefined();
    expect(emitted).toEqual([]);
  });

  it("never fabricates the hardcoded route/tool script it used to emit", async () => {
    process.env["TUI_DISPATCH_ENABLED"] = "true";
    const port = await start();

    await post(port, "/api/v1/dispatch", { prompt: "anything" });
    // The old handler emitted turn.in and route.decided SYNCHRONOUSLY, then
    // tool.call / tool.result / turn.out from a setTimeout(600). Waiting past
    // that timer is what makes this test cover the deferred half too — at 50ms
    // it only ever caught the synchronous events, so three of the four
    // assertions below were passing vacuously.
    await new Promise((r) => setTimeout(r, 700));

    const seams = emitted.map((e) => e.seam);
    expect(seams).not.toContain("route.decided");
    expect(seams).not.toContain("tool.call");
    expect(seams).not.toContain("tool.result");
    expect(seams).not.toContain("turn.out");
  });

  it("still rejects a missing prompt when enabled", async () => {
    process.env["TUI_DISPATCH_ENABLED"] = "true";
    const port = await start();

    expect((await post(port, "/api/v1/dispatch", {})).status).toBe(400);
  });
});

describe("POST /api/v1/hitl/respond — never reports an approval it did not perform", () => {
  it("returns 501 with approved:false instead of {status:'success'}", async () => {
    const port = await start();

    const res = await post(port, "/api/v1/hitl/respond", { id: "hitl-123", action: "approve" });

    expect(res.status).toBe(501);
    expect(res.body["error"]).toBe("not_implemented");
    expect(res.body["approved"]).toBe(false);
    // The exact regression: a success verdict for a no-op approval.
    expect(res.body["status"]).not.toBe("success");
  });

  it("writes NO hitl.resume trace event for an approval that never happened", async () => {
    const port = await start();

    await post(port, "/api/v1/hitl/respond", { id: "hitl-123", action: "approve" });

    expect(emitted.map((e) => e.seam)).not.toContain("hitl.resume");
    expect(emitted).toEqual([]);
  });

  it("names the path that actually works, so the founder is not stranded", async () => {
    const port = await start();

    const res = await post(port, "/api/v1/hitl/respond", { id: "h1", action: "reject" });

    expect(String(res.body["detail"])).toMatch(/Telegram card/i);
    expect(String(res.body["detail"])).toContain("Nothing was approved or rejected");
  });

  it("still validates its input before refusing", async () => {
    const port = await start();

    const res = await post(port, "/api/v1/hitl/respond", { id: "only-id" });

    expect(res.status).toBe(400);
    expect(res.body["error"]).toBe("id_and_action_required");
  });
});
