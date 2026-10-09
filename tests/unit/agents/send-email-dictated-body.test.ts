/**
 * Live QA 2026-10-09: a dictated "body exactly: ..." mail to the founder's own address was blocked twice by the critic,
 * the final reply still printed "1 action completed and verified", and the card that appeared carried a rewritten body.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const hitl = vi.hoisted(() => vi.fn(async (_req: unknown) => null as string | null));
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
import { dictatedBodyFrom, resolveEmailBody } from "../../../src/agents/dictated-body.js";
import { isNoActionResult } from "../../../src/kernel/tool-failure.js";
import { _resetBrandRetries } from "../../../src/infra/brand-retry.js";

const FOUNDER = "Email pushkarai3698@gmail.com subject QA ping and body exactly: ping from the bot, nothing to do here";
const cfg = (founder_text: string) => ({ configurable: { thread_id: "t_dict", founder_text } });

beforeEach(() => {
  _resetBrandRetries();
  hitl.mockClear();
  sent.mockClear();
  judge.mockClear();
});

describe("dictatedBodyFrom / resolveEmailBody", () => {
  it("takes everything after the body label, quotes stripped", () => {
    expect(dictatedBodyFrom(FOUNDER)).toBe("ping from the bot, nothing to do here");
    expect(dictatedBodyFrom('mail a@b.com, the body is exactly: "see you at 5"')).toBe("see you at 5");
    expect(dictatedBodyFrom("mail a@b.com body - ok then")).toBe("ok then");
  });
  it("is null without a label, so a model-written body stays the model's", () => {
    expect(dictatedBodyFrom("write a cold email to the plumber about pricing")).toBeNull();
    expect(resolveEmailBody("Hi, quick question about pricing", "write a cold email to the plumber")).toEqual({
      body: "Hi, quick question about pricing",
      dictated: false,
    });
  });
  it("treats a long verbatim slice of his message as dictated, a short one as not", () => {
    const said = "send mail to x@y.com saying I will be ten minutes late to the standup";
    expect(resolveEmailBody("I will be ten minutes late to the standup", said).dictated).toBe(true);
    expect(resolveEmailBody("late", said).dictated).toBe(false);
  });
});

describe("send_email with a dictated body", () => {
  it("shows the card with his exact body, critic notes as advice, and sends that body", async () => {
    const res = await createSendEmailTool("comms").invoke(
      { to: "pushkarai3698@gmail.com", subject: "QA ping", body: "Hi Pushkar,\n\nA quick ping from the team.\n\nBest regards" },
      cfg(FOUNDER),
    );
    expect(hitl).toHaveBeenCalledTimes(1);
    const card = hitl.mock.calls[0]![0] as { preview: string; summary: string; args: { body: string } };
    expect(card.preview).toBe("ping from the bot, nothing to do here");
    expect(card.args.body).toBe("ping from the bot, nothing to do here");
    expect(card.summary).toContain("advice only");
    expect(card.summary).toContain("agency warmth");
    expect((sent.mock.calls[0]![0] as { body: string }).body).toBe("ping from the bot, nothing to do here");
    expect(res).toContain("Email sent");
  });

  it("is never blocked by the critic, however many times the same dictated mail is tried", async () => {
    for (let i = 0; i < 4; i++) {
      const res = await createSendEmailTool("comms").invoke(
        { to: "pushkarai3698@gmail.com", subject: "QA ping", body: "anything" },
        cfg(`${FOUNDER} ${i}`),
      );
      expect(String(res)).not.toContain("Revise before sending");
    }
    expect(hitl).toHaveBeenCalledTimes(4);
  });
});

describe("send_email that does not send", () => {
  it("a critic block on a model-written body is a no-action result, which the footer does not count", async () => {
    const res = String(
      await createSendEmailTool("comms").invoke(
        { to: "a@b.com", subject: "Hi", body: "Cheers, let's chat soon about pricing options" },
        cfg("email a@b.com about pricing"),
      ),
    );
    expect(hitl).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
    expect(res).toContain("NOT sent");
    expect(isNoActionResult(res)).toBe(true);
  });
});
