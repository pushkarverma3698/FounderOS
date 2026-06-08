/**
 * Unit tests for finalReply() and the embedded stripXmlTags() helper.
 * (src/gateway/telegram.ts)
 *
 * Covers:
 *   - AI text message returned on first pass
 *   - Tool message surfaced when no AI text found (engineering dept fix)
 *   - XML routing markers stripped from AI messages
 *   - Genuine no-output returns "✅ Done."
 *   - AI messages with tool_calls (pending routing) are skipped
 */

import { describe, it, expect } from "vitest";
import { finalReply } from "../../../src/gateway/telegram.js";

// Minimal OfficeMessage factory helpers
function aiMsg(content: string, withToolCalls = false) {
  return {
    content,
    _getType: () => "ai",
    tool_calls: withToolCalls ? [{ name: "search_web" }] : [],
  };
}

function toolMsg(content: string) {
  return {
    content,
    _getType: () => "tool",
    tool_calls: [],
  };
}

function humanMsg(content: string) {
  return {
    content,
    _getType: () => "human",
    tool_calls: [],
  };
}

describe("finalReply", () => {
  it("returns last AI text message when present", () => {
    const res = {
      messages: [humanMsg("run git status"), aiMsg("Here is the output: \n```\nOn branch main\n```")],
    };
    expect(finalReply(res)).toBe("Here is the output: \n```\nOn branch main\n```");
  });

  it("falls back to last tool message when no AI text found (engineering fix)", () => {
    const res = {
      messages: [
        humanMsg("list my repos"),
        aiMsg("", true), // AI msg with tool_calls — should be skipped
        toolMsg("repo1\nrepo2\nrepo3"),
      ],
    };
    const reply = finalReply(res);
    expect(reply).toBe("repo1\nrepo2\nrepo3");
  });

  it("strips XML routing markers from AI reply", () => {
    const res = {
      messages: [
        aiMsg("<name>supervisor</name><content>Here are the results you asked for.</content>"),
      ],
    };
    expect(finalReply(res)).toBe("Here are the results you asked for.");
  });

  it("strips <name> tag but preserves surrounding text", () => {
    const res = {
      messages: [aiMsg("<name>research</name>Found 3 results for your query.")],
    };
    expect(finalReply(res)).toBe("Found 3 results for your query.");
  });

  it("returns '✅ Done.' when messages array is empty", () => {
    expect(finalReply({ messages: [] })).toBe("✅ Done.");
  });

  it("returns '✅ Done.' when only human messages present", () => {
    const res = {
      messages: [humanMsg("Hello"), humanMsg("Still waiting")],
    };
    expect(finalReply(res)).toBe("✅ Done.");
  });

  it("skips AI messages that are pure routing hops (have tool_calls)", () => {
    const res = {
      messages: [
        aiMsg("routing", true), // supervisor routing hop — skip
        toolMsg("actual tool output"),
      ],
    };
    // No clean AI text → falls back to tool message
    expect(finalReply(res)).toBe("actual tool output");
  });
});
