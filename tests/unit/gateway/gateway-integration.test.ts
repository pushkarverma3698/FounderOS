/**
 * Gateway integration tests — covers the pure utility functions and format
 * pipeline used in the Telegram gateway.
 *
 * Rationale: telegram.ts does not export testable handler functions that can
 * be called without a live bot instance and database connection. Instead, this
 * file covers the exported pure-function surface that composes the gateway:
 *
 *   1. format.ts — markdownToTelegramHtml edge cases (regression guards)
 *   2. format.ts — splitForTelegram chunking contract
 *   3. telegram.ts — safeHtml, finalReply, sliceFreshMessages (gateway helpers)
 *   4. commands.ts — /q routing prefix injection (pure wiring contract)
 *
 * All tests are pure — zero I/O, zero network, zero bot token required.
 */

import { describe, it, expect, vi } from "vitest";
import {
  markdownToTelegramHtml,
  splitForTelegram,
  TELEGRAM_MAX,
} from "../../../src/gateway/format.js";
import {
  safeHtml,
  finalReply,
  sliceFreshMessages,
} from "../../../src/gateway/telegram.js";

// ── Helper ────────────────────────────────────────────────────────────────────

function makeMsg(type: string, content: unknown, tool_calls?: unknown[]) {
  return { content, _getType: () => type, ...(tool_calls ? { tool_calls } : {}) };
}

// ── 1. Format — markdownToTelegramHtml edge cases ─────────────────────────────

describe("markdownToTelegramHtml — gateway edge cases", () => {
  it("converts **bold** to <b>bold</b>", () => {
    const out = markdownToTelegramHtml("**bold text**");
    expect(out).toBe("<b>bold text</b>");
  });

  it("converts # heading to <b>Title</b>", () => {
    const out = markdownToTelegramHtml("# Important Title");
    expect(out).toBe("<b>Important Title</b>");
  });

  it("converts inline code `fn()` to <code>fn()</code>", () => {
    const out = markdownToTelegramHtml("call `fn()` now");
    expect(out).toBe("call <code>fn()</code> now");
  });

  it("converts markdown table to <pre> block with no raw pipes", () => {
    const md = "| Name | Value |\n| --- | --- |\n| alpha | 1 |\n| beta | 2 |";
    const out = markdownToTelegramHtml(md);
    expect(out).toContain("<pre>");
    expect(out).toContain("alpha");
    expect(out).not.toMatch(/\|\s*Name\s*\|/);     // no raw header pipes
    expect(out).not.toMatch(/\| --- \|/);           // no separator row
  });

  it("converts [label](url) to <a href='url'>label</a>", () => {
    const out = markdownToTelegramHtml("[docs](https://example.com)");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain(">docs</a>");
  });

  it("does NOT produce nested <b><b> for ## **Heading** pattern", () => {
    const out = markdownToTelegramHtml("## **Section Title**");
    expect(out).toBe("<b>Section Title</b>");
    expect(out).not.toContain("<b><b>");
    expect(out).not.toContain("</b></b>");
  });

  it("handles empty string without throwing", () => {
    expect(() => markdownToTelegramHtml("")).not.toThrow();
    expect(markdownToTelegramHtml("")).toBe("");
  });

  it("leaves plain prose untouched", () => {
    const plain = "Just a simple sentence with no formatting.";
    expect(markdownToTelegramHtml(plain)).toBe(plain);
  });

  it("escapes < > & in plain text to prevent HTML injection", () => {
    const out = markdownToTelegramHtml("a < b && c > d");
    expect(out).toContain("&lt;");
    expect(out).toContain("&gt;");
    expect(out).toContain("&amp;");
  });

  it("handles multi-paragraph Markdown correctly (bullets + bold)", () => {
    const md = "## Summary\n\n**Key point:**\n- First item\n- Second item";
    const out = markdownToTelegramHtml(md);
    expect(out).toContain("<b>Summary</b>");
    expect(out).toContain("<b>Key point:</b>");
    expect(out).toContain("• First item");
    expect(out).toContain("• Second item");
    expect(out).not.toContain("**");
    expect(out).not.toMatch(/^- First/m);
  });
});

// ── 2. Format — splitForTelegram chunking contract ────────────────────────────

describe("splitForTelegram — gateway chunking contract", () => {
  it("returns single chunk for text under TELEGRAM_MAX", () => {
    const short = "Hello, world!";
    const chunks = splitForTelegram(short, TELEGRAM_MAX);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(short);
  });

  it("splits text > 4096 chars into multiple chunks", () => {
    const line = "A".repeat(200);
    const long = Array.from({ length: 30 }, () => line).join("\n"); // ~6k chars
    const chunks = splitForTelegram(long, TELEGRAM_MAX);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("every chunk is at most TELEGRAM_MAX characters", () => {
    const line = "word ".repeat(100);
    const long = Array.from({ length: 20 }, () => line).join("\n");
    const chunks = splitForTelegram(long, TELEGRAM_MAX);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX);
    }
  });

  it("returns [] for empty-string input (no crash)", () => {
    const chunks = splitForTelegram("", TELEGRAM_MAX);
    expect(chunks).toEqual([]);
  });

  it("returns [] for whitespace-only input (no crash)", () => {
    const chunks = splitForTelegram("   \n\n   ", TELEGRAM_MAX);
    expect(chunks).toEqual([]);
  });
});

// ── 3. Gateway helpers — safeHtml and message-slicing ─────────────────────────

describe("safeHtml — gateway XSS guard", () => {
  it("escapes & < > and quotes", () => {
    expect(safeHtml('a & b < c > d "e"')).toBe("a &amp; b &lt; c &gt; d &quot;e&quot;");
  });

  it("returns plain text unchanged", () => {
    expect(safeHtml("plain text")).toBe("plain text");
  });

  it("handles empty string", () => {
    expect(safeHtml("")).toBe("");
  });
});

describe("finalReply — correct AI reply extraction", () => {
  it("returns the last AI message with text", () => {
    const res = {
      messages: [
        makeMsg("human", "hello"),
        makeMsg("ai", "First"),
        makeMsg("ai", "Second"),
      ],
    };
    expect(finalReply(res)).toBe("Second");
  });

  it("skips AI messages that only contain tool_calls", () => {
    const res = {
      messages: [
        makeMsg("ai", "", [{ name: "search_web" }]),
        makeMsg("tool", "search result"),
        makeMsg("ai", "Here is the answer"),
      ],
    };
    expect(finalReply(res)).toBe("Here is the answer");
  });

  it("returns fallback '✅ Done.' when no AI message is found", () => {
    expect(finalReply({ messages: [makeMsg("human", "hi")] })).toBe("✅ Done.");
  });
});

describe("sliceFreshMessages — per-turn isolation", () => {
  const baseTrail = [
    makeMsg("human", "old question"),
    makeMsg("ai", "old answer"),
    makeMsg("tool", "old tool error: something failed"),
  ];

  it("slices only messages added after baseLen", () => {
    const all = [...baseTrail, makeMsg("human", "new q"), makeMsg("ai", "new answer")];
    const fresh = sliceFreshMessages(all, baseTrail.length);
    expect(fresh).toHaveLength(2);
    expect(finalReply({ messages: fresh })).toBe("new answer");
  });

  it("prevents stale tool errors from surfacing in current turn", () => {
    const all = [...baseTrail, makeMsg("human", "new q"), makeMsg("ai", "clean reply")];
    const fresh = sliceFreshMessages(all, baseTrail.length);
    const contents = fresh.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(contents.some((c) => c.includes("old tool error"))).toBe(false);
  });

  it("returns all messages when baseLen is 0 (first turn)", () => {
    expect(sliceFreshMessages(baseTrail, 0)).toHaveLength(baseTrail.length);
  });

  it("returns empty array when baseLen equals trail length (no new messages)", () => {
    expect(sliceFreshMessages(baseTrail, baseTrail.length)).toEqual([]);
  });

  it("does not throw when baseLen exceeds trail length (safe clamping)", () => {
    expect(() => sliceFreshMessages(baseTrail, 9999)).not.toThrow();
    expect(sliceFreshMessages(baseTrail, 9999)).toEqual([]);
  });
});

// ── 4. /q command — department routing prefix injection ──────────────────────
// The /q handler builds `[Route directly to {dept} department]: {task}` and
// calls runOfficeText. We test this by observing what the injected
// runOfficeText callback receives — testing the pure wiring contract.

describe("/q direct-routing — routing prefix injection", () => {
  it("injects the correct routing-hint prefix for a known department", async () => {
    const { handleQ } = await import("../../../src/gateway/commands.js");

    const capturedTexts: string[] = [];
    const mockRunOfficeText = vi.fn(async (_ctx: unknown, text: string) => {
      capturedTexts.push(text);
    });

    const mockCtx = {
      match: "research What is LangGraph?",
      chat: { id: 123 },
      from: { id: 123 },
      reply: vi.fn().mockResolvedValue(undefined),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("grammy").Context;

    await handleQ(mockCtx, mockRunOfficeText);

    expect(mockRunOfficeText).toHaveBeenCalledOnce();
    expect(capturedTexts[0]).toMatch(/^\[Route directly to research department\]:/);
    expect(capturedTexts[0]).toContain("What is LangGraph?");
  });

  it("replies with usage hint when called with empty argument", async () => {
    const { handleQ } = await import("../../../src/gateway/commands.js");

    const mockCtx = {
      match: "",
      chat: { id: 456 },
      from: { id: 456 },
      reply: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("grammy").Context;

    await handleQ(mockCtx, vi.fn());

    expect(mockCtx.reply).toHaveBeenCalledOnce();
    const replyText = (mockCtx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(replyText).toContain("Usage:");
    expect(replyText).toContain("/q");
  });

  it("replies with error when department name is unknown", async () => {
    const { handleQ } = await import("../../../src/gateway/commands.js");

    const mockRunOfficeText = vi.fn();

    const mockCtx = {
      match: "unknowndept do something",
      chat: { id: 789 },
      from: { id: 789 },
      reply: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("grammy").Context;

    await handleQ(mockCtx, mockRunOfficeText);

    expect(mockRunOfficeText).not.toHaveBeenCalled();
    const replyText = (mockCtx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(replyText).toContain("Unknown department");
  });

  it("replies with error when task text is missing after department name", async () => {
    const { handleQ } = await import("../../../src/gateway/commands.js");

    const mockCtx = {
      match: "research",
      chat: { id: 101 },
      from: { id: 101 },
      reply: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("grammy").Context;

    await handleQ(mockCtx, vi.fn());

    const replyText = (mockCtx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(replyText).toContain("Missing task");
  });

  it("preserves full multi-word task text after department in the routing prefix", async () => {
    const { handleQ } = await import("../../../src/gateway/commands.js");

    const capturedTexts: string[] = [];
    const mockRunOfficeText = vi.fn(async (_ctx: unknown, text: string) => {
      capturedTexts.push(text);
    });

    const mockCtx = {
      match: "personal list all files on my Desktop right now",
      chat: { id: 202 },
      from: { id: 202 },
      reply: vi.fn().mockResolvedValue(undefined),
    } as unknown as import("grammy").Context;

    await handleQ(mockCtx, mockRunOfficeText);

    expect(capturedTexts[0]).toContain("list all files on my Desktop right now");
    expect(capturedTexts[0]).toMatch(/^\[Route directly to personal department\]:/);
  });
});
