/**
 * A 🔁 Retry re-runs the WHOLE turn. If that turn had already sent an email
 * before a later step failed, does the retry send it again?
 *
 * It must not — silently. The idempotency key is content-addressed and has no
 * turn id or time in it (src/infra/hitl.ts idemKey), and send_email refuses a
 * recent re-send to the same recipient BEFORE the approval gate. So a retry
 * either stops without a card, or asks again and still skips identical copy.
 * Only different copy, approved again by the founder, can go out a second time.
 *
 * Everything real except the edges: the action_log is an in-memory table, the
 * approval card is "tap Approve", and the provider records sends instead of
 * making them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

interface LoggedAction {
  action: string;
  key: string;
  to: string;
  at: number;
}

let actionLog: LoggedAction[] = [];
let sends = 0;
let approvalCards = 0;
let now = Date.parse("2026-09-28T10:00:00Z");

beforeEach(() => {
  vi.resetModules();
  actionLog = [];
  sends = 0;
  approvalCards = 0;
  now = Date.parse("2026-09-28T10:00:00Z");

  vi.doMock("../../../src/db/queries.js", async () => {
    const actual = await vi.importActual<typeof import("../../../src/db/queries.js")>("../../../src/db/queries.js");
    return {
      ...actual,
      getDailyOutboundCount: async () => 0,
      isSuppressed: async () => false,
      hasRecentOutboundToRecipient: async (_tenant: string, action: string, to: string, withinMs = actual.OUTBOUND_RECIPIENT_DEDUP_MS) =>
        actionLog.some((e) => e.action === action && e.to === to && now - e.at < withinMs),
      hasBeenAudited: async (key: string) => actionLog.some((e) => e.key === key),
      writeAuditEntry: async (entry: { action: string; idempotency_key: string; payload: { to: string } }) => {
        actionLog.push({ action: entry.action, key: entry.idempotency_key, to: entry.payload.to, at: now });
        return { written: true };
      },
    };
  });
  vi.doMock("../../../src/infra/hitl.js", async () => ({
    ...(await vi.importActual<object>("../../../src/infra/hitl.js")),
    hitlGate: async () => {
      approvalCards += 1;
      return null; // the founder taps Approve
    },
  }));
  vi.doMock("../../../src/infra/providers/index.js", async () => ({
    ...(await vi.importActual<object>("../../../src/infra/providers/index.js")),
    providerSendEmail: async () => {
      sends += 1;
      return { success: true, data: { message_id: `m-${sends}` } };
    },
  }));
  vi.doMock("../../../src/infra/judge.js", async () => ({
    ...(await vi.importActual<object>("../../../src/infra/judge.js")),
    judgeOutbound: async () => ({ verdict: "pass" }),
  }));
  vi.doMock("../../../src/infra/brand-validator.js", async () => ({
    ...(await vi.importActual<object>("../../../src/infra/brand-validator.js")),
    validateBrandVoice: () => ({ valid: true, violations: [] }),
  }));
});

const EMAIL = { to: "anna@adyen.com", subject: "FP&A Analyst role", body: "Hi Anna, a short note about the FP&A role." };

async function sendEmailTool() {
  const { createSendEmailTool } = await import("../../../src/agents/agent-tools/comms.js");
  return createSendEmailTool("jobhunt");
}

describe("send_email when a failed turn is retried", () => {
  it("a retry soon after the send is refused before any approval card", async () => {
    const tool = await sendEmailTool();
    expect(await tool.invoke(EMAIL)).toContain("Email sent");
    now += 2 * 60_000; // a later step fails; he taps Retry two minutes later

    const retried = await tool.invoke(EMAIL);
    expect(retried).toMatch(/Already emailed anna@adyen\.com recently — not re-sent/);
    expect(sends).toBe(1);
    expect(approvalCards).toBe(1); // no second card
  });

  it("a retry after the 30-minute window asks again, and identical copy is still not re-sent", async () => {
    const tool = await sendEmailTool();
    await tool.invoke(EMAIL);
    now += 31 * 60_000;

    const retried = await tool.invoke(EMAIL);
    expect(approvalCards).toBe(2); // he is asked, never bypassed
    expect(retried).toMatch(/already sent earlier — not re-sent \(idempotency\)/);
    expect(sends).toBe(1);
  });

  it("only different copy, approved again, can go out a second time", async () => {
    const tool = await sendEmailTool();
    await tool.invoke(EMAIL);
    now += 31 * 60_000;

    await tool.invoke({ ...EMAIL, body: "Hi Anna, following up with my CV attached." });
    expect(approvalCards).toBe(2);
    expect(sends).toBe(2);
  });

  it("uses a key with no turn id or clock in it", async () => {
    const { idemKey } = await import("../../../src/infra/hitl.js");
    const first = idemKey("email", EMAIL.to, EMAIL.subject, EMAIL.body);
    now += 24 * 60 * 60_000;
    expect(idemKey("email", EMAIL.to, EMAIL.subject, EMAIL.body)).toBe(first);
  });
});
