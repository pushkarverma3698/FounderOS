/**
 * Unit tests for the dispatch tick kick.
 *
 * The kick used to spawn the dispatcher as a child of the bot. Under the bot's systemd sandbox
 * (NoNewPrivileges) that child could not `sudo`, so it paused the whole loop with a false "agy is not
 * installed" after every approved /task. It now leaves a note in a file that a per-minute cron job
 * (`agent-dispatch --kicked`) turns into a tick. Nothing in this file may start a process.
 *
 * The kick is a convenience: it saves up to 15 minutes of waiting for the VPS cron. It is never
 * load-bearing, so every failure mode must be silent and harmless. The issue is already filed by the
 * time this runs; cron is the guaranteed path and this only shortens it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { kickDispatchTick, kickFilePath } = await import("../../../src/tools/dispatch-tick.js");

const ORIGINAL_BIN = process.env["AGENT_DISPATCH_BIN"];
const ORIGINAL_FILE = process.env["AGENT_DISPATCH_KICK_FILE"];

beforeEach(() => {
  delete process.env["AGENT_DISPATCH_BIN"];
  delete process.env["AGENT_DISPATCH_KICK_FILE"];
});

afterEach(() => {
  if (ORIGINAL_BIN) process.env["AGENT_DISPATCH_BIN"] = ORIGINAL_BIN;
  else delete process.env["AGENT_DISPATCH_BIN"];
  if (ORIGINAL_FILE) process.env["AGENT_DISPATCH_KICK_FILE"] = ORIGINAL_FILE;
  else delete process.env["AGENT_DISPATCH_KICK_FILE"];
});

describe("kickDispatchTick", () => {
  it("does nothing when AGENT_DISPATCH_BIN is unset", () => {
    // This is what keeps every test run, CI run and laptop run inert by default:
    // only the VPS, where the dispatcher actually exists, sets this.
    const write = vi.fn();
    kickDispatchTick(123, "pushkarverma3698/FounderOS", write);
    expect(write).not.toHaveBeenCalled();
  });

  it("does nothing when AGENT_DISPATCH_BIN is blank", () => {
    process.env["AGENT_DISPATCH_BIN"] = "   ";
    const write = vi.fn();
    kickDispatchTick(123, "pushkarverma3698/FounderOS", write);
    expect(write).not.toHaveBeenCalled();
  });

  it("leaves one line, naming the repo and the issue, in the file the cron job watches", () => {
    process.env["AGENT_DISPATCH_BIN"] = "/home/founderos/bin/agent-dispatch";
    process.env["AGENT_DISPATCH_KICK_FILE"] = "/home/founderos/.claude/agent-dispatch.kick";
    const write = vi.fn();

    kickDispatchTick(670, "pushkarverma3698/FounderOS", write);

    expect(write).toHaveBeenCalledWith("/home/founderos/.claude/agent-dispatch.kick", "pushkarverma3698/FounderOS#670\n");
  });

  it("records an Oplify repo the same way (a bare number is ambiguous across the four repos)", () => {
    process.env["AGENT_DISPATCH_BIN"] = "/home/founderos/bin/agent-dispatch";
    const write = vi.fn();

    kickDispatchTick(42, "OplifyMessage/oplify-messaging-api", write);

    expect(write).toHaveBeenCalledWith(expect.stringContaining("agent-dispatch.kick"), "OplifyMessage/oplify-messaging-api#42\n");
  });

  it("defaults to ~/.claude/agent-dispatch.kick, the file deploy/agent-dispatch reads", () => {
    expect(kickFilePath()).toMatch(/\.claude[\\/]agent-dispatch\.kick$/);
  });

  it("really appends to the file, one line per kick, creating the directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "kick-"));
    try {
      process.env["AGENT_DISPATCH_BIN"] = "/home/founderos/bin/agent-dispatch";
      process.env["AGENT_DISPATCH_KICK_FILE"] = join(dir, "nested", ".claude", "agent-dispatch.kick");

      kickDispatchTick(1, "pushkarverma3698/FounderOS");
      kickDispatchTick(2, "OplifyMessage/oplify-messaging-app");

      expect(readFileSync(process.env["AGENT_DISPATCH_KICK_FILE"], "utf8")).toBe(
        "pushkarverma3698/FounderOS#1\nOplifyMessage/oplify-messaging-app#2\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never starts a process: that is exactly what could not work under the bot's sandbox", () => {
    process.env["AGENT_DISPATCH_BIN"] = "/home/founderos/bin/agent-dispatch";
    const source = readFileSync(new URL("../../../src/tools/dispatch-tick.ts", import.meta.url), "utf8");
    // Comments explain the history; only code is checked.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/child_process|spawn\(|exec\(|execFile/);
  });

  it("swallows a throwing writer — the issue is already filed", () => {
    process.env["AGENT_DISPATCH_BIN"] = "/home/founderos/bin/agent-dispatch";
    const write = vi.fn(() => {
      throw new Error("EACCES");
    });

    expect(() => kickDispatchTick(670, "pushkarverma3698/FounderOS", write)).not.toThrow();
    expect(write).toHaveBeenCalled();
  });

  it("swallows an unwritable path when the real writer is used", () => {
    const dir = mkdtempSync(join(tmpdir(), "kick-"));
    try {
      // A FILE where the directory should be: mkdir fails at once with ENOTDIR, for root and for anyone else.
      // Not a path under /proc: on Linux Node's recursive mkdir never returns there (procfs answers ENOENT for
      // a path whose parent exists, and it retries forever). That froze the CI test job for 25 minutes.
      writeFileSync(join(dir, "blocker"), "");
      process.env["AGENT_DISPATCH_BIN"] = "/home/founderos/bin/agent-dispatch";
      process.env["AGENT_DISPATCH_KICK_FILE"] = join(dir, "blocker", "nested", "agent-dispatch.kick");

      expect(() => kickDispatchTick(670, "pushkarverma3698/FounderOS")).not.toThrow();
      expect(existsSync(join(dir, "blocker", "nested"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a non-positive issue number rather than leaving a note nothing can act on", () => {
    process.env["AGENT_DISPATCH_BIN"] = "/home/founderos/bin/agent-dispatch";
    const write = vi.fn();

    kickDispatchTick(0, "pushkarverma3698/FounderOS", write);
    kickDispatchTick(-1, "pushkarverma3698/FounderOS", write);
    kickDispatchTick(Number.NaN, "pushkarverma3698/FounderOS", write);

    expect(write).not.toHaveBeenCalled();
  });

  it("refuses a blank repo", () => {
    process.env["AGENT_DISPATCH_BIN"] = "/home/founderos/bin/agent-dispatch";
    const write = vi.fn();

    kickDispatchTick(670, "", write);
    kickDispatchTick(670, "   ", write);

    expect(write).not.toHaveBeenCalled();
  });
});
