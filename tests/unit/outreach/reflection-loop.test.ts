/**
 * Outreach reflection loop — offline graph tests ($0, scripted models).
 */

import { describe, it, expect } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { buildOutreachReflectionGraph } from "../../../src/outreach/graph.js";
import { createInMemoryOutreachQueue } from "../../../src/outreach/queue.js";
import { InMemoryDailyLimitTracker } from "../../../src/outreach/validator.js";
import type { LeadContext } from "../../../src/outreach/contracts.js";
import { routeAfterValidator, terminalFailureReason } from "../../../src/outreach/routing.js";
import { validateConnectionDraft } from "../../../src/outreach/validator.js";

class ScriptedChatModel {
  calls = 0;
  constructor(private readonly script: string[]) {}
  async invoke(_messages: BaseMessage[]): Promise<AIMessage> {
    const text = this.script[this.calls] ?? this.script[this.script.length - 1]!;
    this.calls += 1;
    return new AIMessage(text);
  }
}

const baseLead: LeadContext = {
  profile_id: "urn:li:person:abc",
  full_name: "Jane Doe",
  headline: "VP Engineering at Acme",
  company: "Acme",
  icp_match_score: 82,
  personalization_hooks: ["Shipped a LangGraph case study last week"],
};

describe("validateConnectionDraft", () => {
  const limits = new InMemoryDailyLimitTracker(20);

  it("rejects drafts over 300 characters", () => {
    const long = "a".repeat(301);
    const r = validateConnectionDraft({
      draft: long,
      lead_context: baseLead,
      account_id: "acct",
      checkDailyLimit: (id) => limits.check(id),
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("300"))).toBe(true);
  });

  it("rejects URLs", () => {
    const r = validateConnectionDraft({
      draft: "Loved your post — see https://evil.com for more",
      lead_context: baseLead,
      account_id: "acct",
      checkDailyLimit: (id) => limits.check(id),
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.toLowerCase().includes("url"))).toBe(true);
  });

  it("rejects when daily limit exhausted", () => {
    const tight = new InMemoryDailyLimitTracker(1);
    tight.recordSend("acct");
    const r = validateConnectionDraft({
      draft: "Hi Jane — your LangGraph post resonated. Curious how you eval agents?",
      lead_context: baseLead,
      account_id: "acct",
      checkDailyLimit: (id) => tight.check(id),
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("Daily account limit"))).toBe(true);
  });
});

describe("routeAfterValidator", () => {
  it("routes to executor when no errors", () => {
    expect(
      routeAfterValidator({
        validation_errors: [],
        retry_count: 0,
      } as never),
    ).toBe("executor");
  });

  it("routes to reflector when errors and retries remain", () => {
    expect(
      routeAfterValidator({
        validation_errors: ["too long"],
        retry_count: 1,
      } as never),
    ).toBe("reflector");
  });

  it("routes to end when retry cap hit", () => {
    expect(
      routeAfterValidator({
        validation_errors: ["too long"],
        retry_count: 3,
      } as never),
    ).toBe("end");
  });
});

describe("outreach reflection graph", () => {
  it("reflects once then queues a valid draft", async () => {
    const queue = createInMemoryOutreachQueue();
    const limits = new InMemoryDailyLimitTracker();
    const generator = new ScriptedChatModel([
      "Hi Jane — your LangGraph case study was sharp. How are you handling eval gates in prod? https://bad.link",
    ]);
    const reflector = new ScriptedChatModel([
      "Hi Jane — your LangGraph case study was sharp. How are you handling eval gates in prod?",
    ]);

    const graph = buildOutreachReflectionGraph({
      generatorModel: generator as never,
      reflectorModel: reflector as never,
      queue,
      dailyLimits: limits,
      accountId: "founder_li",
    });

    const out = await graph.invoke({
      lead_context: baseLead,
      messages: [],
      current_draft: "",
      validation_errors: [],
      retry_count: 0,
      status: "running",
    });

    expect(out.status).toBe("queued");
    expect(out.queue_id).toBeTruthy();
    expect(out.current_draft).not.toMatch(/https?:\/\//);
    expect(out.current_draft!.length).toBeLessThanOrEqual(300);
    expect(reflector.calls).toBe(1);
    expect(queue.get(out.queue_id!)?.status).toBe("pending");
  });

  it("fails gracefully after max reflections", async () => {
    const bad = "x".repeat(301);
    const generator = new ScriptedChatModel([bad]);
    const reflector = new ScriptedChatModel([bad, bad, bad]);

    const graph = buildOutreachReflectionGraph({
      generatorModel: generator as never,
      reflectorModel: reflector as never,
      accountId: "acct",
    });

    const out = await graph.invoke({
      lead_context: baseLead,
      messages: [],
      current_draft: "",
      validation_errors: [],
      retry_count: 0,
      status: "running",
    });

    expect(out.status).toBe("failed");
    expect(out.failure_reason).toContain("Validation failed");
    expect(terminalFailureReason(out as never)).toContain("300");
  });
});
