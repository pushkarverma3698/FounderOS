/**
 * Regression tests for the resumeOffice checkpoint guard.
 *
 * Bug: When a multi-step engineering HITL chain accumulated large tool outputs,
 * the thread history grew until LangGraph passed empty/blank messages to Gemini,
 * causing 400 "contents is not specified". This test covers the guard added in
 * src/gateway/telegram.ts that validates checkpoint messages before resuming.
 *
 * The guard calls assertNonEmptyMessages(checkpointMessages, "resumeOffice").
 * If it throws, resumeOffice must reply with a user-friendly error and return
 * without calling office.invoke (which would pass bad state to Gemini).
 *
 * Related: MAX_TOOL_OUTPUT reduced 10,000→2,000 as the primary fix (prevents
 * accumulation). This guard is the secondary safety net if state is already bad.
 */

import { describe, it, expect, vi } from "vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { assertNonEmptyMessages } from "../../../src/infra/office-guard.js";

// ── Inline re-implementation of the guard logic ───────────────────────────────
// We test the guard logic directly, not via the full grammy context, because
// wiring up a real Context + office in unit tests is heavy.
// The invariant: assertNonEmptyMessages must throw on the same inputs that
// would cause resumeOffice to bail out and reply with the error message.

describe("resumeOffice checkpoint guard (assertNonEmptyMessages)", () => {
  it("passes when checkpoint has valid human and AI messages", () => {
    const messages = [
      new HumanMessage({ content: "build a feature", id: "h1" }),
      new AIMessage({ content: "I'll help with that", id: "a1" }),
    ];
    expect(() => assertNonEmptyMessages(messages, "resumeOffice")).not.toThrow();
  });

  it("throws when checkpoint messages array is empty (blank state)", () => {
    const messages: never[] = [];
    expect(() => assertNonEmptyMessages(messages, "resumeOffice")).toThrow(
      /empty/i,
    );
  });

  it("throws when last message content is blank (trim side-effect or corruption)", () => {
    const messages = [
      new HumanMessage({ content: "run pnpm test", id: "h1" }),
      new AIMessage({ content: "", id: "a1" }),
    ];
    expect(() => assertNonEmptyMessages(messages, "resumeOffice")).toThrow(
      /blank/i,
    );
  });

  it("throws when last message content is whitespace-only", () => {
    const messages = [
      new HumanMessage({ content: "run the tests", id: "h1" }),
      new AIMessage({ content: "   ", id: "a1" }),
    ];
    expect(() => assertNonEmptyMessages(messages, "resumeOffice")).toThrow();
  });

  it("passes with a single valid human message (minimal state)", () => {
    const messages = [new HumanMessage({ content: "list files", id: "h1" })];
    expect(() => assertNonEmptyMessages(messages, "resumeOffice")).not.toThrow();
  });

  it("passes for a long multi-step HITL chain where last message is valid", () => {
    // Simulates a branch→write→write→test chain (4 HITL steps)
    const messages = [];
    for (let i = 0; i < 8; i++) {
      messages.push(new HumanMessage({ content: `step ${i}`, id: `h${i}` }));
      messages.push(
        new AIMessage({
          content: `[...${2_000} chars truncated — use targeted commands]`,
          id: `a${i}`,
        }),
      );
    }
    expect(() => assertNonEmptyMessages(messages, "resumeOffice")).not.toThrow();
  });

  it("context string appears in error when context is 'resumeOffice'", () => {
    const messages: never[] = [];
    let errorMsg = "";
    try {
      assertNonEmptyMessages(messages, "resumeOffice");
    } catch (e) {
      errorMsg = (e as Error).message;
    }
    // Error must be attributable to resumeOffice context for debuggability
    expect(errorMsg).toMatch(/resumeOffice/i);
  });
});

// ── Guard behaviour contract ───────────────────────────────────────────────────
// These tests verify that a blank/empty checkpoint is distinguishable from a
// valid one BEFORE any invoke() call — ensuring the guard fires early.

describe("resumeOffice guard placement contract", () => {
  it("guard can check messages without calling office.invoke", () => {
    // Simulates what resumeOffice does: read checkpoint, check, then decide
    const checkpointMessages = [] as never[];
    const invokeCalled = { value: false };

    let guardPassed = false;
    try {
      assertNonEmptyMessages(checkpointMessages, "resumeOffice");
      guardPassed = true;
    } catch {
      // guard fires — invoke must NOT be called
    }

    if (guardPassed) {
      invokeCalled.value = true; // would call office.invoke here
    }

    expect(invokeCalled.value).toBe(false); // guard prevented invoke
  });

  it("guard allows invoke when checkpoint is valid", () => {
    const checkpointMessages = [
      new HumanMessage({ content: "approved — proceed", id: "h1" }),
    ];
    const invokeCalled = { value: false };

    try {
      assertNonEmptyMessages(checkpointMessages, "resumeOffice");
      invokeCalled.value = true; // guard passed — invoke would run
    } catch {
      // guard would block
    }

    expect(invokeCalled.value).toBe(true); // valid checkpoint proceeds normally
  });
});
