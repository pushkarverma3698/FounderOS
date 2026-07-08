/**
 * v3 kernel tool adapter — the ONE conversion path from UnifiedTool to the
 * worker engine. Gate ordering (HITL → idempotency → execute → audit) is the
 * proven CLAUDE #4/#5 sequence; these tests pin it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const interruptMock = vi.fn();
vi.mock("@langchain/langgraph", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, interrupt: (payload: unknown) => interruptMock(payload) };
});

const dbState = { pending: null as unknown, audited: false };
const createInterrupt = vi.fn(async () => ({}));
const hasBeenAudited = vi.fn(async () => dbState.audited);
const writeAuditEntry = vi.fn(async () => ({ written: true }));
vi.mock("../../../src/db/queries.js", () => ({
  getPendingInterrupt: vi.fn(async () => dbState.pending),
  createInterrupt,
  hasBeenAudited,
  writeAuditEntry,
}));

const { adaptTool, formatToolResult } = await import("../../../src/kernel/tool-adapter.js");
const { isFailureResult } = await import("../../../src/kernel/worker.js");
import type { UnifiedTool } from "../../../src/tools/index.js";

const execute = vi.fn(async () => ({ success: true, data: { message_id: "m1" } }));
const emailTool: UnifiedTool = { name: "send_email", description: "send", execute };

const gate = {
  action: "email_sent",
  title: (a: Record<string, unknown>) => `Send email to ${a["to"]}?`,
  idemParts: (a: Record<string, unknown>) => [String(a["to"]), String(a["subject"])],
};

const config = { configurable: { thread_id: "t:1" } };

beforeEach(() => {
  vi.clearAllMocks();
  dbState.pending = null;
  dbState.audited = false;
});

describe("formatToolResult", () => {
  it("success → data verbatim; failure → ❌ + structured marker", () => {
    expect(formatToolResult("x", { success: true, data: "plain" })).toBe("plain");
    expect(formatToolResult("x", { success: true, data: { a: 1 } })).toBe(`{"a":1}`);
    const fail = formatToolResult("send_email", { success: false, error: "SMTP down" });
    expect(fail).toContain("❌ send_email failed: SMTP down");
    expect(isFailureResult(fail)).toBe(true);
    expect(isFailureResult(formatToolResult("x", { success: true, data: "ok" }))).toBe(false);
  });
});

describe("ungated tool", () => {
  it("executes directly; thrown errors become failure envelopes, not crashes", async () => {
    const boom: UnifiedTool = {
      name: "search",
      description: "s",
      execute: async () => {
        throw new Error("Apify quota exhausted");
      },
    };
    const result = (await adaptTool(boom).invoke({}, config)) as string;
    expect(isFailureResult(result)).toBe(true);
    expect(result).toContain("Apify quota exhausted");
    expect(interruptMock).not.toHaveBeenCalled();
  });
});

describe("gated tool — HITL → idempotency → execute → audit", () => {
  it("approved: DB row before interrupt, side effect once, audit row written", async () => {
    interruptMock.mockReturnValue("approved");
    const result = await adaptTool(emailTool, { gate }).invoke({ to: "a@b.c", subject: "hi" }, config);

    expect(createInterrupt).toHaveBeenCalledTimes(1); // rule #4: row BEFORE interrupt
    expect(interruptMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "approval", action: "email_sent", title: "Send email to a@b.c?" }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: "email_sent", idempotency_key: expect.stringContaining("email_sent:") }),
    );
    expect(String(result)).toContain("message_id");
  });

  it("rejected: terminal rejection string, NO execute, NO audit", async () => {
    interruptMock.mockReturnValue("rejected");
    const result = await adaptTool(emailTool, { gate }).invoke({ to: "a@b.c", subject: "hi" }, config);

    expect(result).toBe("❌ Rejected by founder.");
    expect(execute).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it("idempotency: an already-audited action is skipped, never re-executed", async () => {
    interruptMock.mockReturnValue("approved");
    dbState.audited = true;
    const result = await adaptTool(emailTool, { gate }).invoke({ to: "a@b.c", subject: "hi" }, config);

    expect(String(result)).toContain("already executed");
    expect(execute).not.toHaveBeenCalled();
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it("failed execute: failure envelope returned, NO audit row (rule: audit only on real success)", async () => {
    interruptMock.mockReturnValue("approved");
    execute.mockResolvedValueOnce({ success: false, error: "SMTP down" } as never);
    const result = (await adaptTool(emailTool, { gate }).invoke({ to: "a@b.c", subject: "hi" }, config)) as string;

    expect(isFailureResult(result)).toBe(true);
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });
});
