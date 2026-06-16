/**
 * Crash recovery: after a bot restart the LangGraph checkpoint still holds the
 * interrupt but Telegram inline buttons on the old message are dead. Startup must
 * re-post a fresh approval card.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatApprovalCard } from "../../../src/gateway/office-run.js";
import type { ApprovalRequest } from "../../../src/agents/agent-tools.js";

const approval: ApprovalRequest = {
  kind: "approval",
  action: "send_email",
  title: "📧 Send email to test@turicks.com?",
  summary: "Subject: Probe",
  preview: "one line",
  args: { to: "test@turicks.com" },
};

describe("formatApprovalCard", () => {
  it("includes restart banner when afterRestart is set", () => {
    const { html } = formatApprovalCard(approval, { afterRestart: true });
    expect(html).toContain("Resuming after restart");
    expect(html).toContain("Send email");
  });

  it("omits restart banner on a normal in-turn card", () => {
    const { html } = formatApprovalCard(approval);
    expect(html).not.toContain("Resuming after restart");
  });
});

describe("restorePendingApprovalAfterRestart", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("re-posts a card when getPendingApproval returns an interrupt", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../../../src/agents/office.js", () => ({
      getOffice: vi.fn().mockResolvedValue({ getState: vi.fn() }),
      getPendingApproval: vi.fn().mockResolvedValue(approval),
    }));
    vi.doMock("../../../src/gateway/telegram.js", () => ({
      getBot: () => ({ api: { sendMessage } }),
    }));

    const { restorePendingApprovalAfterRestart } = await import(
      "../../../src/gateway/office-run.js"
    );
    const ok = await restorePendingApprovalAfterRestart("123");
    expect(ok).toBe(true);
    expect(sendMessage).toHaveBeenCalledOnce();
    const [, html] = sendMessage.mock.calls[0]!;
    expect(String(html)).toContain("Resuming after restart");
  });

  it("is a no-op when no interrupt is pending", async () => {
    const sendMessage = vi.fn();
    vi.doMock("../../../src/agents/office.js", () => ({
      getOffice: vi.fn().mockResolvedValue({ getState: vi.fn() }),
      getPendingApproval: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock("../../../src/gateway/telegram.js", () => ({
      getBot: () => ({ api: { sendMessage } }),
    }));

    const { restorePendingApprovalAfterRestart } = await import(
      "../../../src/gateway/office-run.js"
    );
    const ok = await restorePendingApprovalAfterRestart("123");
    expect(ok).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
