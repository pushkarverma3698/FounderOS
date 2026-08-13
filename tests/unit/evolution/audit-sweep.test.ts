/**
 * Task 3 — the acting loop ALWAYS reports.
 * =========================================
 * The old sweep had exactly one behaviour on every failure: log
 * "Self-audit sweep error (non-fatal)" and send nothing. From the founder's
 * chat, a crashed audit, a cron that never fired, and an audit with nothing to
 * report were the same event — silence. These pin the replacement.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AuditRunResult } from "../../../src/evolution/run-audit.js";

const sendToChat = vi.fn(async () => {});
vi.mock("../../../src/infra/telegram-send.js", () => ({ sendToChat }));

const CLEAN_RUN: AuditRunResult = {
  staticResults: [{ analyzer: "findDeadExports", findings: [] }],
  telemetryResults: [],
  telemetrySkippedReason: null,
  ranked: [],
};

const runSelfAudit = vi.fn(async (): Promise<AuditRunResult> => CLEAN_RUN);
const persistAuditRun = vi.fn(async () => ({ state: "disabled" as const }));
vi.mock("../../../src/evolution/run-audit.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, runSelfAudit, persistAuditRun };
});

const { runSelfAuditSweep } = await import("../../../src/evolution/audit-sweep.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runSelfAuditSweep", () => {
  it("sends exactly one HTML message on the happy path", async () => {
    await runSelfAuditSweep();

    expect(sendToChat).toHaveBeenCalledTimes(1);
    const [, parseMode] = sendToChat.mock.calls[0] as unknown as [string, string];
    expect(parseMode).toBe("HTML");
  });

  it("still reports when the audit itself throws, naming the reason", async () => {
    runSelfAudit.mockRejectedValueOnce(new Error("ENOENT: no such file dist/package.json"));

    await runSelfAuditSweep();

    expect(sendToChat).toHaveBeenCalledTimes(1);
    const [text] = sendToChat.mock.calls[0] as unknown as [string];
    expect(text).toContain("SELF-AUDIT FAILED TO RUN");
    expect(text).toContain("dist/package.json");
  });

  it("reports a skipped telemetry tier instead of a clean-looking report", async () => {
    runSelfAudit.mockResolvedValueOnce({
      staticResults: [{ analyzer: "findDeadExports", findings: [] }],
      telemetryResults: [],
      telemetrySkippedReason: "connect ECONNREFUSED 127.0.0.1:5432",
      ranked: [],
    });

    await runSelfAuditSweep();

    const [text] = sendToChat.mock.calls[0] as unknown as [string];
    expect(text).toContain("TELEMETRY DID NOT RUN");
    expect(text).toContain("ECONNREFUSED");
  });

  it("does not throw into the scheduler when Telegram itself is down", async () => {
    sendToChat.mockRejectedValueOnce(new Error("429 Too Many Requests"));

    // The cron callback in src/infra/scheduler.ts only has a .catch for logging;
    // an escaping rejection here is an unhandled rejection in the bot process.
    await expect(runSelfAuditSweep()).resolves.toBeUndefined();
  });

  it("persists before rendering, so the delta can appear in the sent message", async () => {
    await runSelfAuditSweep();

    expect(persistAuditRun).toHaveBeenCalledTimes(1);
    expect(persistAuditRun.mock.invocationCallOrder[0]!).toBeLessThan(
      sendToChat.mock.invocationCallOrder[0]!,
    );
  });
});
