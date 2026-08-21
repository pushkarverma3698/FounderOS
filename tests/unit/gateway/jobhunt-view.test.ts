/**
 * Unit tests — /jobs and /csv, the two commands that made the shortlist visible.
 *
 * Both replaced a Google Sheet that was never configured, so the property that
 * matters most is that NEITHER GOES QUIET. The previous export path failed
 * silently for two weeks — `exportJobSheet` returned "not set up" 48 times a day
 * and the ranking was discarded — and a command that produces no reply is
 * indistinguishable from that.
 */

import { describe, it, expect, vi } from "vitest";
import type { Context } from "grammy";
import {
  parseCsvKind,
  csvFilename,
  csvCaption,
  handleJobs,
} from "../../../src/gateway/jobhunt-view.js";

/** Minimal grammy Context: only the two reply methods these handlers touch. */
function fakeCtx() {
  const replies: string[] = [];
  const ctx = {
    reply: vi.fn(async (text: string) => {
      replies.push(text);
    }),
  } as unknown as Context;
  return { ctx, replies };
}

describe("parseCsvKind", () => {
  it("defaults a bare /csv to the apply queue — the thing he acts on", () => {
    expect(parseCsvKind("")).toBe("queue");
  });

  it("understands the words a person would actually type for the full list", () => {
    expect(parseCsvKind("all")).toBe("log");
    expect(parseCsvKind("log")).toBe("log");
    expect(parseCsvKind(" ALL ")).toBe("log");
  });

  it("falls back to the queue on anything unrecognised rather than erroring", () => {
    // A usage error is how a command gets typed once and never again.
    expect(parseCsvKind("pls")).toBe("queue");
  });
});

describe("csvFilename", () => {
  it("dates the file so two downloads never collide in a file picker", () => {
    expect(csvFilename("queue", new Date("2026-08-21T09:00:00Z"))).toBe("jobs-queue-2026-08-21.csv");
  });
});

describe("csvCaption", () => {
  it("says the queue is empty rather than sending a bare file with one header row", () => {
    expect(csvCaption("queue", 0)).toMatch(/empty/i);
  });

  it("names the count and what /draft takes, so the file need not be opened to be useful", () => {
    const caption = csvCaption("queue", 6);
    expect(caption).toContain("6");
    expect(caption).toContain("/draft");
  });

  it("marks the log as the audit trail, never as the shortlist", () => {
    expect(csvCaption("log", 40)).toMatch(/audit|rejects/i);
  });
});

describe("handleJobs", () => {
  it("says it is working before a slow ranking, so the founder does not retry it", async () => {
    const { ctx, replies } = fakeCtx();

    await handleJobs(ctx, { buildBrief: async () => "brief", split: (t) => [t] });

    expect(replies[0]).toMatch(/ranking/i);
  });

  it("sends every chunk of a brief too long for one Telegram message", async () => {
    const { ctx, replies } = fakeCtx();

    await handleJobs(ctx, {
      buildBrief: async () => "a".repeat(10_000),
      split: () => ["part one", "part two", "part three"],
    });

    expect(replies).toContain("part one");
    expect(replies).toContain("part three");
  });

  it("reports a ranking failure and points at the fallback — never silence", async () => {
    const { ctx, replies } = fakeCtx();

    await handleJobs(ctx, {
      buildBrief: async () => {
        throw new Error("column posted_at does not exist");
      },
      split: (t) => [t],
    });

    const last = replies.at(-1)!;
    expect(last).toContain("column posted_at does not exist");
    expect(last).toContain("/csv");
  });
});
