/**
 * Unit tests for the dispatch tick kick.
 *
 * The kick is a convenience: it saves up to 15 minutes of waiting for the VPS cron.
 * It is never load-bearing, so the property that matters most here is that every
 * failure mode is silent and harmless — an unset binary, a throwing spawner, a
 * missing executable. The issue is already filed by the time this runs; cron is the
 * guaranteed path and this only shortens it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { kickDispatchTick } = await import("../../../src/tools/dispatch-tick.js");

const ORIGINAL_BIN = process.env["AGENT_DISPATCH_BIN"];

beforeEach(() => {
  delete process.env["AGENT_DISPATCH_BIN"];
});

afterEach(() => {
  if (ORIGINAL_BIN) process.env["AGENT_DISPATCH_BIN"] = ORIGINAL_BIN;
  else delete process.env["AGENT_DISPATCH_BIN"];
});

describe("kickDispatchTick", () => {
  it("does nothing when AGENT_DISPATCH_BIN is unset", () => {
    // This is what keeps every test run, CI run and laptop run inert by default:
    // only the VPS, where the dispatcher actually exists, sets this.
    const spawn = vi.fn();
    kickDispatchTick(123, spawn);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does nothing when AGENT_DISPATCH_BIN is blank", () => {
    process.env["AGENT_DISPATCH_BIN"] = "   ";
    const spawn = vi.fn();
    kickDispatchTick(123, spawn);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("targets the issue it just filed, not a bare tick", () => {
    // A bare tick scans the agent:ready queue and may claim a DIFFERENT issue —
    // the founder would watch Antigravity start work he did not just ask for.
    process.env["AGENT_DISPATCH_BIN"] = "/home/founderos/bin/agent-dispatch";
    const spawn = vi.fn();

    kickDispatchTick(670, spawn);

    expect(spawn).toHaveBeenCalledWith("/home/founderos/bin/agent-dispatch", ["--issue", "670"]);
  });

  it("swallows a throwing spawner — the issue is already filed", () => {
    process.env["AGENT_DISPATCH_BIN"] = "/home/founderos/bin/agent-dispatch";
    const spawn = vi.fn(() => {
      throw new Error("ENOENT");
    });

    expect(() => kickDispatchTick(670, spawn)).not.toThrow();
    expect(spawn).toHaveBeenCalled();
  });

  it("refuses a non-positive issue number rather than spawning a wild claim", () => {
    process.env["AGENT_DISPATCH_BIN"] = "/home/founderos/bin/agent-dispatch";
    const spawn = vi.fn();

    kickDispatchTick(0, spawn);
    kickDispatchTick(-1, spawn);
    kickDispatchTick(Number.NaN, spawn);

    expect(spawn).not.toHaveBeenCalled();
  });
});
