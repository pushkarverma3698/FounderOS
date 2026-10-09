/**
 * Live QA 2026-10-09 09:47: the card said "Editor notes (advice only; your wording is sent as written)", the founder
 * tapped Approve, and the reply said the 2nd-pass editor rejected the draft and nothing was sent.
 *
 * Cause: approving re-runs the tool from the top. The resume config carries no `founder_text`, so the replay lost the
 * "body exactly: ..." label, treated the model's rewrite as the body, and ran it through the blocking critic.
 * The approved card (`hitl_resumed`) is the record of what he approved: the replay must send that, and nothing else.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const hitl = vi.hoisted(() => vi.fn(async (_req: unknown, _cfg?: unknown) => null as string | null));
const sent = vi.hoisted(() => vi.fn(async (_args: unknown) => ({ success: true, data: {} })));
const judge = vi.hoisted(() => vi.fn(async () => ({ verdict: "revise" as const, critique: "Add agency warmth and a sign-off." })));

vi.mock("../../../src/agents/agent-tools/hitl.js", () => ({ hitlGate: hitl, idemKey: (...p: string[]) => p.join("|") }));
vi.mock("../../../src/tools/email.js", () => ({ emailTool: { execute: sent } }));
vi.mock("../../../src/infra/judge.js", () => ({ judgeOutbound: judge }));
vi.mock("../../../src/db/queries.js", () => ({
  getDailyOutboundCount: async () => 0,
  hasRecentOutboundToRecipient: async () => false,
  isSuppressed: async () => false,
  getRecentLinkedInPosts: async () => [],
  listUpcomingScheduledPosts: async () => [],
}));

import { createSendEmailTool } from "../../../src/agents/agent-tools/comms.js";
import { approvedEmailFrom } from "../../../src/agents/dictated-body.js";
import { _resetBrandRetries } from "../../../src/infra/brand-retry.js";

const FOUNDER = "send an email to pushkarai3698@gmail.com with subject QA test 9 Oct and body: This is a live QA test from FounderOS. Please ignore.";
const DICTATED = "This is a live QA test from FounderOS. Please ignore.";
const MODEL_REWRITE = "Hi Pushkar,\n\nThis is a QA test message.\n\nBest regards";
const ARGS = { to: "pushkarai3698@gmail.com", subject: "QA test 9 Oct", body: MODEL_REWRITE };

beforeEach(() => {
  _resetBrandRetries();
  hitl.mockClear();
  sent.mockClear();
  judge.mockClear();
});

describe("send_email replay after the founder taps Approve", () => {
  it("sends the body on the approved card, not the model's rewrite, and the critic cannot block it", async () => {
    const tool = createSendEmailTool("comms");
    // Run 1: the card is raised from the founder's own words.
    await tool.invoke(ARGS, { configurable: { thread_id: "t_replay", founder_text: FOUNDER } });
    const card = hitl.mock.calls[0]![0] as { preview: string };
    expect(card.preview).toBe(DICTATED);
    const approvedCard = JSON.stringify(card);

    hitl.mockClear();
    sent.mockClear();
    judge.mockClear();

    // Run 2: the resume replay. No founder_text; the gateway names the card he approved.
    const res = String(await tool.invoke(ARGS, { configurable: { thread_id: "t_replay", hitl_resumed: approvedCard } }));

    expect(res).not.toContain("NOT sent");
    expect(res).toContain("Email sent");
    expect((sent.mock.calls[0]![0] as { body: string }).body).toBe(DICTATED);
    // The replay raises the identical payload, so hitlGate recognises it as the resume of the approved card (#1055).
    expect(JSON.stringify(hitl.mock.calls[0]![0])).toBe(approvedCard);
    // Nothing is judged again: he already approved exactly this.
    expect(judge).not.toHaveBeenCalled();
  });

  it("also protects a model-written body whose first pass was approved with the critic's warning", async () => {
    const tool = createSendEmailTool("comms");
    const card = {
      action: "send_email",
      title: "📧 Send email to a@b.com?",
      summary: "Subject: Hi\n⚠️ 2nd-pass editor still flags this after 2 revisions — approve to send/post as-is, or reject:\nwarmer",
      preview: "Quick note about pricing, call me when free.",
      args: { to: "a@b.com", subject: "Hi", body: "Quick note about pricing, call me when free." },
    };
    const res = String(
      await tool.invoke(
        { to: "a@b.com", subject: "Hi", body: "Quick note about pricing, call me when free." },
        { configurable: { thread_id: "t_replay2", hitl_resumed: JSON.stringify(card) } },
      ),
    );
    expect(res).toContain("Email sent");
    expect(JSON.stringify(hitl.mock.calls[0]![0])).toBe(JSON.stringify(card));
  });

  it("ignores a resumed card for a different email", async () => {
    const other = { action: "send_email", title: "t", summary: "s", preview: "p", args: { to: "x@y.com", subject: "Other", body: "other body here" } };
    expect(approvedEmailFrom(JSON.stringify(other), "a@b.com", "Hi")).toBeNull();
    expect(approvedEmailFrom("not json", "a@b.com", "Hi")).toBeNull();
    expect(approvedEmailFrom(undefined, "a@b.com", "Hi")).toBeNull();
    expect(approvedEmailFrom(JSON.stringify({ ...other, action: "linkedin_post" }), "x@y.com", "Other")).toBeNull();
  });
});
