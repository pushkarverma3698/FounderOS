/**
 * Outreach reflection loop — E2E graph proof ($0, scripted models).
 * Proves every terminal path: direct queue, reflect-then-queue, retry cap fail.
 * Uses runOutreachReflection() — the same entrypoint as the CLI / API route.
 */

import { describe, it, expect } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import {
  runOutreachReflection,
  OutreachQueuePayloadSchema,
  OUTREACH_MAX_CHARS,
  OUTREACH_MAX_RETRIES,
} from "../../../src/outreach/index.js";
import { createInMemoryOutreachQueue } from "../../../src/outreach/queue.js";
import { InMemoryDailyLimitTracker } from "../../../src/outreach/validator.js";
import type { LeadContext } from "../../../src/outreach/contracts.js";

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

describe("outreach reflection E2E", () => {
  it("path A: valid first draft → queued with paced schedule + daily limit consumed", async () => {
    const queue = createInMemoryOutreachQueue();
    const limits = new InMemoryDailyLimitTracker();
    const generator = new ScriptedChatModel([GOOD_NOTE]);
    const reflector = new ScriptedChatModel(["should not run"]);

    const before = limits.check("founder_li").remaining;

    const result = await runOutreachReflection(baseLead, {
      generatorModel: generator as never,
      reflectorModel: reflector as never,
      queue,
      dailyLimits: limits,
      accountId: "founder_li",
    });

    expect(result.status).toBe("queued");
    expect(result.retry_count).toBe(0);
    expect(reflector.calls).toBe(0);
    expect(result.draft).toBe(GOOD_NOTE);
    expect(result.draft.length).toBeLessThanOrEqual(OUTREACH_MAX_CHARS);
    expect(result.queue_id).toBeTruthy();
    expect(result.queue_entry?.status).toBe("pending");
    expect(result.queue_entry?.profile_id).toBe(baseLead.profile_id);

    const payload = OutreachQueuePayloadSchema.parse(result.queue_entry);
    expect(new Date(payload.scheduled_at).getTime()).toBeGreaterThan(Date.now());
    expect(payload.pacing_jitter_ms).toBeGreaterThan(0);
    expect(payload.message).toBe(GOOD_NOTE);

    expect(limits.check("founder_li").remaining).toBe(before - 1);
    expect(queue.listPending("founder_li")).toHaveLength(1);
  });

  it("path B: URL in first draft → reflect once → queued clean draft", async () => {
    const queue = createInMemoryOutreachQueue();
    const generator = new ScriptedChatModel([`${GOOD_NOTE} https://bad.link`]);
    const reflector = new ScriptedChatModel([GOOD_NOTE]);

    const result = await runOutreachReflection(baseLead, {
      generatorModel: generator as never,
      reflectorModel: reflector as never,
      queue,
      accountId: "acct_b",
    });

    expect(result.status).toBe("queued");
    expect(result.retry_count).toBe(1);
    expect(reflector.calls).toBe(1);
    expect(result.draft).not.toMatch(/https?:\/\//);
    expect(OutreachQueuePayloadSchema.safeParse(result.queue_entry).success).toBe(true);
  });

  it("path C: unfixable draft → fails after max reflections", async () => {
    const tooLong = "x".repeat(OUTREACH_MAX_CHARS + 1);
    const generator = new ScriptedChatModel([tooLong]);
    const reflector = new ScriptedChatModel([tooLong, tooLong, tooLong]);

    const result = await runOutreachReflection(baseLead, {
      generatorModel: generator as never,
      reflectorModel: reflector as never,
      accountId: "acct_c",
    });

    expect(result.status).toBe("failed");
    expect(result.retry_count).toBe(OUTREACH_MAX_RETRIES);
    expect(result.failure_reason).toMatch(/Validation failed after 3 reflection/);
    expect(result.queue_id).toBeUndefined();
    expect(reflector.calls).toBe(OUTREACH_MAX_RETRIES);
  });

  it("path D: daily limit blocks queue even when draft is valid", async () => {
    const limits = new InMemoryDailyLimitTracker(1);
    limits.recordSend("saturated");
    const generator = new ScriptedChatModel([GOOD_NOTE]);

    const result = await runOutreachReflection(baseLead, {
      generatorModel: generator as never,
      reflectorModel: generator as never,
      dailyLimits: limits,
      accountId: "saturated",
    });

    expect(result.status).toBe("failed");
    expect(result.failure_reason).toContain("Daily account limit");
    expect(result.queue_id).toBeUndefined();
  });
});
