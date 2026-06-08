/**
 * Unit tests for assertNonEmptyMessages (src/infra/office-guard.ts).
 *
 * Guards every office.invoke() + resumeOffice() call from Gemini 400
 * "contents is not specified" errors. Pure function — no mocks needed.
 */

import { describe, it, expect } from "vitest";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { assertNonEmptyMessages } from "../../../src/infra/office-guard.js";

describe("assertNonEmptyMessages", () => {
  it("passes when last message has non-empty string content", () => {
    const msgs = [new HumanMessage("Hello, list my files")];
    expect(() => assertNonEmptyMessages(msgs, "test")).not.toThrow();
  });

  it("passes with multiple messages — validates only the last", () => {
    const msgs = [new HumanMessage("first"), new AIMessage("second reply")];
    expect(() => assertNonEmptyMessages(msgs, "test")).not.toThrow();
  });

  it("throws when messages array is empty", () => {
    expect(() => assertNonEmptyMessages([], "runOfficeText")).toThrow(
      "[runOfficeText] Office invoked with empty messages array",
    );
  });

  it("throws when last message has whitespace-only content", () => {
    const msgs = [new HumanMessage("   ")];
    expect(() => assertNonEmptyMessages(msgs, "resumeOffice")).toThrow(
      "[resumeOffice] Last message has empty content",
    );
  });
});
