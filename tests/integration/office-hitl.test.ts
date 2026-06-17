/**
 * FounderOS v2 — Office HITL integration test
 * ============================================
 * Proves the ONE thing v1 got wrong: approval gates the REAL action.
 *
 *   - Email request → supervisor routes to comms → send_email fires interrupt()
 *   - Resume "rejected" → the real email tool is NEVER called
 *   - Resume "approved" → the real email tool IS called exactly once
 *   - Web research → routes to research, returns content, NO interrupt
 *
 * Uses the real Gemini model (cheap) + MemorySaver. External side-effects
 * (email send, web search, suppression) are mocked so nothing leaves the box.
 * Skips automatically when no real Google key is configured.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemorySaver, Command } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";

// ── Mock external side-effects BEFORE importing the office ────────────────────

const emailExecute = vi.fn(async () => ({
  success: true,
  data: { message_id: "msg_test_123", to: "test@example.com" },
}));

vi.mock("../../src/tools/email.js", () => ({
  emailTool: { name: "send_email", description: "mock", execute: emailExecute },
}));

const searchExecute = vi.fn(async () => ({
  success: true,
  data: [
    { title: "Stripe — Payments Infrastructure", url: "https://stripe.com", snippet: "Online payment processing for internet businesses." },
  ],
}));

vi.mock("../../src/tools/web-search.js", () => ({
  webSearchTool: { name: "search_web", description: "mock", execute: searchExecute },
}));

vi.mock("../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, isSuppressed: vi.fn(async () => false) };
});

import { hasLiveIntegrationModel } from "./live-model-guard.js";

// Import AFTER mocks are registered
const { buildOffice, getPendingApproval } = await import("../../src/agents/office.js");

const d = hasLiveIntegrationModel() ? describe : describe.skip;

d("Office HITL loop (live model, mocked side-effects)", () => {
  beforeEach(() => {
    emailExecute.mockClear();
    searchExecute.mockClear();
  });

  it("email request → interrupt fired, REJECT → email NOT sent", { timeout: 90_000 }, async () => {
    const office = buildOffice(new MemorySaver());
    const config = { configurable: { thread_id: "hitl-reject" } };

    await office.invoke(
      { messages: [new HumanMessage("Send an email to test@example.com with the subject 'Hello' and body 'Just saying hi.'")] },
      config,
    );

    // The graph must have paused for approval
    const approval = await getPendingApproval(office, config);
    expect(approval, "expected an approval interrupt").toBeTruthy();
    expect(approval!.action).toBe("send_email");
    expect(approval!.args["to"]).toBe("test@example.com");
    expect(emailExecute).not.toHaveBeenCalled();

    // Reject → real send must NOT happen
    await office.invoke(new Command({ resume: "rejected" }), config);
    expect(emailExecute).not.toHaveBeenCalled();
  });

  it("email request → interrupt fired, APPROVE → email sent exactly once", { timeout: 90_000 }, async () => {
    const office = buildOffice(new MemorySaver());
    const config = { configurable: { thread_id: "hitl-approve" } };

    await office.invoke(
      { messages: [new HumanMessage("Send an email to test@example.com with the subject 'Hello' and body 'Just saying hi.'")] },
      config,
    );

    const approval = await getPendingApproval(office, config);
    expect(approval, "expected an approval interrupt").toBeTruthy();
    expect(emailExecute).not.toHaveBeenCalled();

    // Approve → the REAL tool runs
    await office.invoke(new Command({ resume: "approved" }), config);
    expect(emailExecute).toHaveBeenCalledOnce();
  });

  it("web research → routes to research, returns content, NO interrupt", { timeout: 90_000 }, async () => {
    const office = buildOffice(new MemorySaver());
    const config = { configurable: { thread_id: "research-1" } };

    const res = (await office.invoke(
      { messages: [new HumanMessage("Search the web and tell me what Stripe does.")] },
      config,
    )) as { messages: Array<{ content: unknown }> };

    const approval = await getPendingApproval(office, config);
    expect(approval, "research should NOT need approval").toBeNull();
    expect(searchExecute).toHaveBeenCalled();
    const lastMsg = res.messages[res.messages.length - 1];
    expect(String(lastMsg.content).toLowerCase()).toContain("stripe");
  });
});
