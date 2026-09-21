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
    kickDispatchTick(123, "pushkarverma3698/FounderOS", spawn);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does nothing when AGENT_DISPATCH_BIN is blank", () => {
    process.env["AGENT_DISPATCH_BIN"] = "   ";
    const spawn = vi.fn();
    kickDispatchTick(123, "pushkarverma3698/FounderOS", spawn);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("targets the issue it just filed, in the repo it was filed in", () => {
    // A bare `--issue` tick (no --repo) scans the multi-repo loop and may claim
    // the same-numbered issue in the WRONG repo — confirmed live 2026-09-21.
    process.env["AGENT_DISPATCH_BIN"] = "/home/founderos/bin/agent-dispatch";
    const spawn = vi.fn();

    kickDispatchTick(670, "pushkarverma3698/FounderOS", spawn);

    expect(spawn).toHaveBeenCalledWith("/home/founderos/bin/agent-dispatch", [
      "--issue",
      "670",
      "--repo",
      "pushkarverma3698/FounderOS",
    ]);
  });

  it("targets an Oplify repo the same way as FounderOS", () => {
    process.env["AGENT_DISPATCH_BIN"] = "/home/founderos/bin/agent-dispatch";
    const spawn = vi.fn();

    kickDispatchTick(42, "OplifyMessage/oplify-messaging-api", spawn);

    expect(spawn).toHaveBeenCalledWith("/home/founderos/bin/agent-dispatch", [
      "--issue",
      "42",
      "--repo",
      "OplifyMessage/oplify-messaging-api",
    ]);
  });

  it("swallows a throwing spawner — the issue is already filed", () => {
    process.env["AGENT_DISPATCH_BIN"] = "/home/founderos/bin/agent-dispatch";
    const spawn = vi.fn(() => {
      throw new Error("ENOENT");
    });

    expect(() => kickDispatchTick(670, "pushkarverma3698/FounderOS", spawn)).not.toThrow();
    expect(spawn).toHaveBeenCalled();
  });

  it("refuses a non-positive issue number rather than spawning a wild claim", () => {
    process.env["AGENT_DISPATCH_BIN"] = "/home/founderos/bin/agent-dispatch";
    const spawn = vi.fn();

    kickDispatchTick(0, "pushkarverma3698/FounderOS", spawn);
    kickDispatchTick(-1, "pushkarverma3698/FounderOS", spawn);
    kickDispatchTick(Number.NaN, "pushkarverma3698/FounderOS", spawn);

    expect(spawn).not.toHaveBeenCalled();
  });

  it("refuses a blank repo rather than letting the loop claim the wrong one", () => {
    process.env["AGENT_DISPATCH_BIN"] = "/home/founderos/bin/agent-dispatch";
    const spawn = vi.fn();

    kickDispatchTick(670, "", spawn);
    kickDispatchTick(670, "   ", spawn);

    expect(spawn).not.toHaveBeenCalled();
  });
});
