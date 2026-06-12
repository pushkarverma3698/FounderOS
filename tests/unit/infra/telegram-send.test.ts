/**
 * Unit tests for chunkText — the pure splitter behind sendLongText.
 *
 * Telegram caps a message at 4096 chars. A long claude_code result must be
 * delivered to the founder WITHOUT truncation (the old sendStatusText sliced to
 * 4000 and silently dropped the rest). chunkText splits on newline boundaries so
 * code blocks and lists stay readable across messages.
 */

import { describe, it, expect } from "vitest";
import { chunkText } from "../../../src/infra/telegram-send.js";

describe("chunkText", () => {
  it("returns a single chunk when the text fits", () => {
    expect(chunkText("hello world", 3800)).toEqual(["hello world"]);
  });

  it("returns an empty array for empty input", () => {
    expect(chunkText("", 3800)).toEqual([]);
  });

  it("never produces a chunk longer than the limit", () => {
    const text = "x".repeat(10_000);
    const chunks = chunkText(text, 3800);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(3800);
  });

  it("preserves every character across the split (no data loss)", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}: ${"=".repeat(20)}`);
    const text = lines.join("\n");
    const chunks = chunkText(text, 1000);
    // Rejoining with newline must reproduce the original exactly (we split on \n).
    expect(chunks.join("\n")).toBe(text);
  });

  it("prefers to break at a newline boundary, not mid-line", () => {
    const text = "aaaa\nbbbb\ncccc\ndddd";
    const chunks = chunkText(text, 10);
    // Each chunk should end on a complete line (no trailing partial token).
    for (const c of chunks) expect(c.endsWith("a") || c.endsWith("b") || c.endsWith("c") || c.endsWith("d")).toBe(true);
    expect(chunks.join("\n")).toBe(text);
  });

  it("hard-cuts a single line with no newline rather than overflowing", () => {
    const text = "y".repeat(5000);
    const chunks = chunkText(text, 2000);
    expect(chunks.every((c) => c.length <= 2000)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });
});
