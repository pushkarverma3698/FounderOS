/**
 * replyForError — the generic ❌ path's message scrubbing (src/gateway/error-reply.ts).
 *
 * The founder is the only reader. Scrubbing exists to drop stack frames and SQL
 * dumps, not to delete the words that say what went wrong.
 */

import { describe, it, expect } from "vitest";
import type { Context } from "grammy";

const { replyForError } = await import("../../../src/gateway/error-reply.js");

async function shown(err: unknown): Promise<string> {
  const replies: string[] = [];
  const ctx = { reply: async (text: string) => void replies.push(text) } as unknown as Context;
  await replyForError(ctx, err);
  return replies[0] ?? "";
}

describe("replyForError — generic error text", () => {
  it("keeps ordinary English words that happen to be SQL keywords", async () => {
    // PR #731 review: a case-insensitive SQL regex turned this into "Could not read [query]".
    const text = await shown(new Error("Could not read from repository: select a branch and update it"));
    expect(text).toContain("Could not read from repository");
    expect(text).toContain("select a branch and update it");
  });

  it("still removes a raw SQL statement", async () => {
    const text = await shown(new Error('relation missing: SELECT * FROM agents.job_applications WHERE id = 4'));
    expect(text).not.toContain("agents.job_applications");
    expect(text).toContain("relation missing");
  });

  it("drops stack frames and absolute paths", async () => {
    const err = new Error("boom at /opt/founderos/src/x.ts:1:2");
    err.message += "\n    at run (/opt/founderos/src/x.ts:1:2)";
    const text = await shown(err);
    expect(text).not.toContain("/opt/founderos");
    expect(text).toContain("boom");
  });
});
