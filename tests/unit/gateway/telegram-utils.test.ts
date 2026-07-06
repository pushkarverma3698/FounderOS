/**
 * Unit tests for pure Telegram gateway utility functions.
 * These are stateless helpers — no mocks needed.
 */

import { describe, it, expect } from "vitest";
import { safeHtml, finalReply, collectToolErrors, sliceFreshMessages } from "../../../src/gateway/telegram.js";
import { toolNotice } from "../../../src/agents/tool-result.js";

// ── safeHtml ──────────────────────────────────────────────────────────────────

describe("safeHtml", () => {
  it("escapes ampersands", () => {
    expect(safeHtml("A & B")).toBe("A &amp; B");
  });

  it("escapes angle brackets", () => {
    expect(safeHtml("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes double quotes", () => {
    expect(safeHtml('say "hello"')).toBe("say &quot;hello&quot;");
  });

  it("returns plain text unchanged", () => {
    expect(safeHtml("Hello world")).toBe("Hello world");
  });

  it("handles empty string", () => {
    expect(safeHtml("")).toBe("");
  });

  it("escapes all special chars in one string", () => {
    expect(safeHtml('<a href="x&y">test</a>')).toBe(
      '&lt;a href=&quot;x&amp;y&quot;&gt;test&lt;/a&gt;',
    );
  });
});

// ── finalReply ────────────────────────────────────────────────────────────────

function makeMsg(type: string, content: unknown, tool_calls?: unknown[]) {
  return { content, _getType: () => type, ...(tool_calls ? { tool_calls } : {}) };
}

describe("finalReply", () => {
  it("returns the last AI message text", () => {
    const res = {
      messages: [
        makeMsg("human", "hello"),
        makeMsg("ai", "First response"),
        makeMsg("ai", "Final response"),
      ],
    };
    expect(finalReply(res)).toBe("Final response");
  });

  it("skips AI messages that only have tool_calls", () => {
    const res = {
      messages: [
        makeMsg("ai", "", [{ name: "search_web" }]),
        makeMsg("tool", "search result"),
        makeMsg("ai", "Based on research: X"),
      ],
    };
    expect(finalReply(res)).toBe("Based on research: X");
  });

  it("trims whitespace from the reply", () => {
    const res = { messages: [makeMsg("ai", "  hello  ")] };
    expect(finalReply(res)).toBe("hello");
  });

  it("returns fallback when no AI messages", () => {
    const res = { messages: [makeMsg("human", "hello")] };
    expect(finalReply(res)).toBe("⚠️ No reply generated — agent completed without output. Check /runs.");
  });

  it("returns fallback when messages is empty", () => {
    expect(finalReply({ messages: [] })).toBe("⚠️ No reply generated — agent completed without output. Check /runs.");
  });

  it("returns fallback when messages is undefined", () => {
    expect(finalReply({})).toBe("⚠️ No reply generated — agent completed without output. Check /runs.");
  });

  it("skips AI messages with empty content", () => {
    const res = {
      messages: [makeMsg("ai", ""), makeMsg("ai", "Real reply")],
    };
    expect(finalReply(res)).toBe("Real reply");
  });
});

// ── collectToolErrors ─────────────────────────────────────────────────────────

describe("collectToolErrors", () => {
  it("returns empty array when no tool messages", () => {
    const res = { messages: [makeMsg("human", "hi"), makeMsg("ai", "ok")] };
    expect(collectToolErrors(res)).toEqual([]);
  });

  it("returns empty array when tool messages have no error keywords", () => {
    const res = { messages: [makeMsg("tool", "3 results found")] };
    expect(collectToolErrors(res)).toEqual([]);
  });

  it("collects 'error' keyword tool messages", () => {
    const res = { messages: [makeMsg("tool", "Search error: timeout")] };
    expect(collectToolErrors(res)).toHaveLength(1);
    expect(collectToolErrors(res)[0]).toContain("Search error");
  });

  it("collects 'not configured' keyword tool messages", () => {
    const res = { messages: [makeMsg("tool", "COMPOSIO_API_KEY not configured")] };
    expect(collectToolErrors(res)).toHaveLength(1);
  });

  it("collects 'fail' keyword", () => {
    const res = { messages: [makeMsg("tool", "Email send failed: 401")] };
    expect(collectToolErrors(res)).toHaveLength(1);
  });

  it("collects 'blocked' keyword", () => {
    const res = { messages: [makeMsg("tool", "BLOCKED: address on suppression list")] };
    expect(collectToolErrors(res)).toHaveLength(1);
  });

  it("collects multiple tool errors", () => {
    const res = {
      messages: [
        makeMsg("tool", "Web search failed"),
        makeMsg("ai", "trying another approach"),
        makeMsg("tool", "Email error: timeout"),
      ],
    };
    expect(collectToolErrors(res)).toHaveLength(2);
  });

  it("truncates long error messages to 300 chars", () => {
    const longMsg = "error: " + "x".repeat(400);
    const res = { messages: [makeMsg("tool", longMsg)] };
    expect(collectToolErrors(res)[0]!.length).toBeLessThanOrEqual(300);
  });

  it("ignores non-tool messages even if they contain error keywords", () => {
    const res = { messages: [makeMsg("ai", "there was an error in the system")] };
    expect(collectToolErrors(res)).toEqual([]);
  });

  // Regression (F1, 2026-06-12): a SUCCESSFUL multi-line tool result whose body
  // happens to contain an error keyword (e.g. read_context returning the
  // founder's stored notes that mention "tests fail") was falsely surfaced as a
  // "⚠️ Tool issue" and its raw 800-char dump appended to the founder's reply,
  // disfiguring a 100%-correct answer. Errors live on the FIRST line; content
  // bodies do not.
  it("does NOT flag a successful multi-line result whose body mentions an error word", () => {
    const ctx =
      "Current business context:\n" +
      "• companies: Turicks (AI automation agency) + Naggar Retreat\n" +
      "• priorities: ship FounderOS, don't let the tests fail before launch\n" +
      "• tech stack: LangGraph JS, Gemini 2.5";
    const res = { messages: [makeMsg("tool", ctx)] };
    expect(collectToolErrors(res)).toEqual([]);
  });

  it("does NOT flag a successful research body that discusses failures/errors", () => {
    const body =
      "Top findings:\n1. Many startups fail due to poor unit economics.\n" +
      "2. Error budgets are an SRE best practice.\n3. Invalid assumptions kill roadmaps.";
    const res = { messages: [makeMsg("tool", body)] };
    expect(collectToolErrors(res)).toEqual([]);
  });

  it("flags a structured failure object even if the flag is not on the first visual line", () => {
    const res = { messages: [makeMsg("tool", '{"success":false,"error":"Email send failed: 401"}')] };
    expect(collectToolErrors(res)).toHaveLength(1);
  });

  // Regression (rule #22/#24, 2026-06-17): a stage-tagged failure envelope must
  // be detected deterministically by the gateway — no reliance on the keyword
  // heuristic. This is how DB/Postgres failures now surface to the founder.
  it("flags a structured tool-failure envelope via the marker (no error keyword in body)", () => {
    // Body deliberately has NO error keyword — only the [[TOOL_FAILURE]] marker
    // proves detection, so this genuinely exercises the deterministic path.
    // Multi-line body so neither the first-line keyword check nor the marker's
    // own "FAILURE" word lands on line 1 — only isStructuredToolFailure can catch it.
    const res = {
      messages: [
        makeMsg("tool", "❌ turicks_brain returned nothing\nfrom the Postgres lookup [[TOOL_FAILURE stage=db]]"),
      ],
    };
    expect(collectToolErrors(res)).toHaveLength(1);
    expect(collectToolErrors(res)[0]).toContain("Postgres");
  });

  // M4 regression: a deliberate, successful soft-decline (suppression block,
  // daily limit, duplicate-outreach guard) must NOT be flagged as a tool
  // issue, even though its first line contains keywords ("blocked", "limit
  // reached") the legacy heuristic scans for. Before the fix, comms.ts's own
  // real messages for these cases triggered a false-positive "⚠️ Tool issue"
  // banner on a 100%-correct outcome.
  it("does NOT flag a do-not-contact suppression block (real comms.ts message, M4)", () => {
    const msg = toolNotice("BLOCKED: alice@x.com is on the do-not-contact list. Email not sent.");
    const res = { messages: [makeMsg("tool", msg)] };
    expect(collectToolErrors(res)).toEqual([]);
  });

  it("does NOT flag a daily send-limit notice (real comms.ts message, M4)", () => {
    const msg = toolNotice("Daily email limit reached (20/20 sent today). Try again tomorrow or increase DAILY_EMAIL_LIMIT.");
    const res = { messages: [makeMsg("tool", msg)] };
    expect(collectToolErrors(res)).toEqual([]);
  });

  it("still flags the SAME wording when it is NOT wrapped in toolNotice (heuristic unchanged for un-migrated tools)", () => {
    // Confirms the fix is scoped to the marker, not a blanket keyword exemption.
    const res = { messages: [makeMsg("tool", "BLOCKED: alice@x.com is on the do-not-contact list. Email not sent.")] };
    expect(collectToolErrors(res)).toHaveLength(1);
  });
});

// ── sliceFreshMessages (per-turn isolation) ─────────────────────────────────────
// The checkpointer returns the FULL thread trail on every invoke. To stop the
// gateway resurrecting stale replies / old tool errors, we slice to only the
// messages added during the current turn (everything past baseLen captured
// before the invoke).

describe("sliceFreshMessages", () => {
  const trail = [
    makeMsg("human", "old q"),
    makeMsg("ai", "old answer"),
    makeMsg("tool", "old error: boom"),
  ];

  it("returns only messages added after baseLen", () => {
    const all = [...trail, makeMsg("human", "new q"), makeMsg("ai", "new answer")];
    const fresh = sliceFreshMessages(all, trail.length);
    expect(fresh).toHaveLength(2);
    expect(finalReply({ messages: fresh })).toBe("new answer");
  });

  it("excludes a stale tool error from a previous turn", () => {
    const all = [...trail, makeMsg("human", "new q"), makeMsg("ai", "clean answer")];
    const fresh = sliceFreshMessages(all, trail.length);
    expect(collectToolErrors({ messages: fresh })).toEqual([]);
  });

  it("returns all messages when baseLen is 0", () => {
    expect(sliceFreshMessages(trail, 0)).toHaveLength(3);
  });

  it("returns empty when baseLen equals length (no new messages this turn)", () => {
    expect(sliceFreshMessages(trail, trail.length)).toEqual([]);
  });

  it("clamps a baseLen larger than the trail to empty (never throws)", () => {
    expect(sliceFreshMessages(trail, 999)).toEqual([]);
  });

  it("treats a negative baseLen as 0", () => {
    expect(sliceFreshMessages(trail, -5)).toHaveLength(3);
  });
});
