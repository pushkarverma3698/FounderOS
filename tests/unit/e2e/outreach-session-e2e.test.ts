/**
 * Session E2E — outreach reflection subgraph (deterministic, $0).
 */

import { describe, it, expect } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import {
  runOutreachReflection,
  OUTREACH_MAX_CHARS,
  OUTREACH_MAX_RETRIES,
  type LeadContext,
} from "../../../src/outreach/index.js";
import { createInMemoryOutreachQueue } from "../../../src/outreach/queue.js";
import { InMemoryDailyLimitTracker, validateConnectionDraft } from "../../../src/outreach/validator.js";

class ScriptedChatModel {
  calls = 0;
  constructor(private readonly script: string[]) {}
  async invoke(_messages: BaseMessage[]): Promise<AIMessage> {
    const text = this.script[this.calls] ?? this.script[this.script.length - 1]!;
    this.calls += 1;
    return new AIMessage(text);
  }
}

const GOOD_NOTE =
  "Hi Jane — your LangGraph eval post was sharp. How are you handling tool-call drift in prod?";

const baseLead: LeadContext = {
  profile_id: "urn:li:person:abc",
  full_name: "Jane Doe",
  headline: "VP Engineering at Acme",
  company: "Acme",
  icp_match_score: 82,
  personalization_hooks: ["Shipped a LangGraph case study last week"],
};

describe("session E2E — outreach reflection subgraph", () => {
  it("happy path: valid draft → queued with persistence in memory queue", async () => {
    const queue = createInMemoryOutreachQueue();
    const limits = new InMemoryDailyLimitTracker();
    const result = await runOutreachReflection(baseLead, {
      generatorModel: new ScriptedChatModel([GOOD_NOTE]) as never,
      reflectorModel: new ScriptedChatModel(["unused"]) as never,
      queue,
      dailyLimits: limits,
      accountId: "founder_li",
    });

    expect(result.status).toBe("queued");
    expect(result.queue_id).toBeTruthy();
    expect(queue.get(result.queue_id!)?.message).toBe(GOOD_NOTE);
    expect(limits.check("founder_li").remaining).toBe(19);
  });

  it("recovery path: URL in draft → reflector cleans → queued", async () => {
    const result = await runOutreachReflection(baseLead, {
      generatorModel: new ScriptedChatModel([`${GOOD_NOTE} https://evil.com`]) as never,
      reflectorModel: new ScriptedChatModel([GOOD_NOTE]) as never,
      accountId: "acct_recovery",
    });

    expect(result.status).toBe("queued");
    expect(result.retry_count).toBe(1);
    expect(result.draft).not.toMatch(/https?:\/\//);
  });

  it("error path: unfixable length → fails after max reflections", async () => {
    const bad = "x".repeat(OUTREACH_MAX_CHARS + 1);
    const result = await runOutreachReflection(baseLead, {
      generatorModel: new ScriptedChatModel([bad]) as never,
      reflectorModel: new ScriptedChatModel([bad, bad, bad]) as never,
      accountId: "acct_fail",
    });

    expect(result.status).toBe("failed");
    expect(result.retry_count).toBe(OUTREACH_MAX_RETRIES);
    expect(result.failure_reason).toMatch(/Validation failed after 3 reflection/);
  });

  it("edge: daily limit exhausted blocks queue despite valid draft", async () => {
    const limits = new InMemoryDailyLimitTracker(1);
    limits.recordSend("saturated");
    const result = await runOutreachReflection(baseLead, {
      generatorModel: new ScriptedChatModel([GOOD_NOTE]) as never,
      reflectorModel: new ScriptedChatModel([GOOD_NOTE]) as never,
      dailyLimits: limits,
      accountId: "saturated",
    });

    expect(result.status).toBe("failed");
    expect(result.failure_reason).toContain("Daily account limit");
  });

  it("edge: ICP score below floor cannot be fixed by reflection", async () => {
    const lowIcpLead: LeadContext = { ...baseLead, icp_match_score: 25 };
    const result = await runOutreachReflection(lowIcpLead, {
      generatorModel: new ScriptedChatModel([GOOD_NOTE]) as never,
      reflectorModel: new ScriptedChatModel([GOOD_NOTE, GOOD_NOTE, GOOD_NOTE]) as never,
      accountId: "low_icp",
    });

    expect(result.status).toBe("failed");
    expect(result.failure_reason).toMatch(/ICP|Validation failed/);
    expect(
      validateConnectionDraft({
        draft: GOOD_NOTE,
        lead_context: lowIcpLead,
        account_id: "low_icp",
        checkDailyLimit: () => ({ allowed: true, sent_today: 0, daily_limit: 20, remaining: 20 }),
      }).valid,
    ).toBe(false);
  });

  it("edge: empty personalization_hooks still queues valid draft", async () => {
    const leadNoHooks: LeadContext = { ...baseLead, personalization_hooks: [] };
    const result = await runOutreachReflection(leadNoHooks, {
      generatorModel: new ScriptedChatModel([GOOD_NOTE]) as never,
      reflectorModel: new ScriptedChatModel(["unused"]) as never,
      accountId: "no_hooks",
    });
    expect(result.status).toBe("queued");
  });
});
