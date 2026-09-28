/**
 * The failure card: what went wrong in plain words, with a 🔁 Retry button.
 *
 * Until 2026-09-28 a failed task reached the founder as `formatFailureReply`
 * (src/kernel/supervisor.ts): `Task stopped at step "s1" — validation failure
 * in kernel/worker`. On 09-16 he typed "Try again" by hand twice. The kernel
 * text is unchanged (it also feeds planner history); this is the gateway's
 * rendering of the same FailureReport. The component still reaches him — the
 * CLAUDE.md invariant — inside an expandable block rather than as the headline.
 */

import { describe, it, expect } from "vitest";
import type { KernelStateType } from "../../../src/kernel/index.js";
import { failureCardFor, renderFailureCard } from "../../../src/gateway/failure-card.js";
import { RETRY_CALLBACK_PREFIX, parseRetryCallback, retryCallbackData } from "../../../src/gateway/retry-button.js";

const TURN_ID = "3f2a9c1e-7b4d-4c2a-9e1f-0a1b2c3d4e5f";

function failedState(overrides: Partial<KernelStateType> = {}): KernelStateType {
  return {
    turn: { id: TURN_ID, chat_id: "777", received_at: "", raw_input: "list my 3 most recent emails" },
    mission: {
      goal: "list my 3 most recent emails",
      status: "failed",
      cursor: 1,
      plan: {
        schema_version: 1,
        goal: "g",
        steps: [
          { step_id: "s1", worker: "comms", objective: "Read the inbox with read_emails", inputs: {}, expected: { kind: "data", schema_ref: "x" }, constraints: { max_tool_calls: 3, hitl_required: false } },
          { step_id: "s2", worker: "comms", objective: "Summarise the three newest <emails> for the founder", inputs: {}, expected: { kind: "data", schema_ref: "y" }, constraints: { max_tool_calls: 3, hitl_required: false } },
        ],
      },
    },
    results: [{ step_id: "s1", status: "ok", output: "3 emails read", receipts: [] }],
    failure: {
      step_id: "s2",
      stage: "validation",
      component: "kernel/worker",
      message: "Output did not match email_summary: missing field sender",
      evidence: '{"subject":"Invoice <#42>"}',
      retryable: true,
    },
    reply: "⚠️ Task stopped at step \"s2\" — validation failure in kernel/worker.",
    ...overrides,
  } as unknown as KernelStateType;
}

const callbackDataOf = (keyboard: unknown): string[] =>
  ((keyboard as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined)?.inline_keyboard ?? [])
    .flat()
    .map((b) => b.callback_data ?? "");

describe("renderFailureCard", () => {
  const html = renderFailureCard(failedState() as never, { retry: true });

  it("leads with the failed objective and the reason, in words", () => {
    expect(html).toContain("I couldn't finish:");
    expect(html).toContain("Summarise the three newest &lt;emails&gt; for the founder");
    expect(html).toMatch(/Why:<\/b> Output did not match/);
  });

  it("keeps internal identifiers out of the headline lines", () => {
    const [headline] = html.split("<blockquote");
    expect(headline).not.toContain("email_summary");
    expect(headline).not.toContain("read_emails");
  });

  it("lists what finished before it stopped", () => {
    expect(html).toContain("Done before it stopped");
    expect(html).toContain("Read the inbox");
    expect(html).toContain("3 emails read");
  });

  it("still shows stage, component and evidence — collapsed, escaped", () => {
    expect(html).toContain("<blockquote expandable>");
    expect(html).toContain("validation · kernel/worker");
    expect(html).toContain("email_summary"); // the raw message survives in the details
    expect(html).toContain("Invoice &lt;#42&gt;");
    expect(html).not.toContain("<#42>");
  });

  it("says a retry cannot re-send anything without his approval, only when a button is attached", () => {
    expect(html).toMatch(/Retry/);
    expect(renderFailureCard(failedState() as never, { retry: false })).not.toMatch(/Retry/);
  });

  it("falls back to the request itself when the failure is not a plan step", () => {
    const planFailure = failedState({
      failure: { step_id: "plan", stage: "planning", component: "kernel/planner", message: "Planner did not return JSON.", retryable: false },
      mission: { goal: "list my 3 most recent emails", status: "failed", plan: null, cursor: 0 },
      results: [],
    } as never);
    const text = renderFailureCard(planFailure as never, { retry: true });
    expect(text).toContain("list my 3 most recent emails");
    expect(text).not.toContain("Done before it stopped");
  });
});

describe("failureCardFor — when the Retry button is offered", () => {
  it("returns nothing when the turn did not fail", () => {
    expect(failureCardFor(failedState({ failure: null } as never), { turnId: TURN_ID })).toBeNull();
  });

  it("returns nothing for a rejected approval — he said no, there is nothing to retry", () => {
    const rejected = failedState({
      failure: { step_id: "s2", stage: "hitl_rejected", component: "send_email", message: "Rejected by founder.", retryable: false },
    } as never);
    expect(failureCardFor(rejected, { turnId: TURN_ID })).toBeNull();
  });

  it("attaches a Retry button naming the failed turn", () => {
    const card = failureCardFor(failedState(), { turnId: TURN_ID });
    expect(callbackDataOf(card?.keyboard)).toEqual([`${RETRY_CALLBACK_PREFIX}3f2a9c1e`]);
  });

  it("carries the candidate's profile, so a retried /draft drafts for the same person", () => {
    const card = failureCardFor(failedState(), { turnId: TURN_ID, profileId: "wife-nl-finance" });
    const [data] = callbackDataOf(card?.keyboard);
    expect(data).toBe("retry:3f2a9c1e:wife-nl-finance");
    expect(Buffer.byteLength(data!, "utf8")).toBeLessThanOrEqual(64);
  });
});

describe("retry callback data", () => {
  it("round-trips the nonce and the profile", () => {
    expect(parseRetryCallback(retryCallbackData(TURN_ID, "wife-nl-finance")!)).toEqual({
      nonce: "3f2a9c1e",
      profileId: "wife-nl-finance",
    });
    expect(parseRetryCallback(retryCallbackData(TURN_ID)!)).toEqual({ nonce: "3f2a9c1e" });
  });

  it("offers no button rather than one that would drop the profile to fit 64 bytes", () => {
    const longProfile = "p".repeat(60);
    expect(retryCallbackData(TURN_ID, longProfile)).toBeNull();
    const card = failureCardFor(failedState(), { turnId: TURN_ID, profileId: longProfile });
    expect(card?.keyboard).toBeUndefined();
    expect(card?.html).not.toMatch(/Retry/);
  });

  it("rejects payloads that are not a retry", () => {
    expect(parseRetryCallback("approve:3f2a9c1e")).toBeNull();
    expect(parseRetryCallback("retry:")).toBeNull();
    expect(parseRetryCallback("retry:short")).toBeNull();
  });
});
