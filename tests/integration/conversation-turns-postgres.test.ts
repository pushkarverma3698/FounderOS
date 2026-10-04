/**
 * The conversation log against REAL Postgres (skipped when DATABASE_URL is unreachable, like the other suites here).
 *
 * Proves what the unit suite's fake reader cannot: that the SQL behaves. The things recall depends on:
 *   - writing the same turn twice stores it once (the (thread_id, turn_id) key);
 *   - a read never crosses threads (the privacy boundary for guests in allow-listed groups);
 *   - the window is [since, until), and topic words match input OR reply, ranked by how many matched;
 *   - the total counts every match, not just the page shown.
 *
 *   DATABASE_URL=postgresql://…/dev ALLOW_NETWORK=1 \
 *     pnpm vitest run --config vitest.integration.config.ts tests/integration/conversation-turns-postgres.test.ts
 *
 * Each test files its rows under thread ids no other test uses and removes them afterwards: TEST cleanup of rows
 * this file created. The product never deletes a turn.
 */

import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { inArray } from "drizzle-orm";
import { closeDatabaseConnections, getDb } from "../../src/db/client.js";
import { conversationTurns } from "../../src/db/schema.js";
import {
  earliestConversationTurn,
  findConversationTurns,
  recordConversationTurn,
  type StoredTurn,
} from "../../src/db/conversation-turns.js";

async function postgresReachable(): Promise<boolean> {
  const url = process.env["DATABASE_URL"];
  if (!url) return false;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {}); // allow-failopen: a failed disconnect of the probe connection changes nothing
  }
}

const pgUp = await postgresReachable();
if (!pgUp) {
  // eslint-disable-next-line no-console
  console.warn("[conversation-turns-postgres] SKIP: Postgres unreachable at DATABASE_URL");
}

const threads: string[] = [];
const newThread = (): string => {
  const id = `t-int-${randomUUID()}`;
  threads.push(id);
  return id;
};

const turn = (over: Partial<StoredTurn> & { at: string }): StoredTurn => ({
  turn_id: randomUUID(),
  user_input: "hello",
  goal: "greet",
  outcome: "replied",
  reply: "Hi.",
  ...over,
});

afterAll(async () => {
  if (!pgUp) return;
  if (threads.length > 0) await getDb().delete(conversationTurns).where(inArray(conversationTurns.thread_id, threads));
  await closeDatabaseConnections();
});

describe.runIf(pgUp)("conversation_turns — real Postgres", () => {
  it("stores a turn once however many times it is recorded", async () => {
    const thread = newThread();
    const t = turn({ at: "2026-10-03T16:11:00Z", user_input: "check the PR bot" });
    await recordConversationTurn(thread, t);
    await recordConversationTurn(thread, t);
    const page = await findConversationTurns({ threadId: thread, terms: [], limit: 10 });
    expect(page.total).toBe(1);
    expect(page.turns[0]).toMatchObject({ turn_id: t.turn_id, user_input: "check the PR bot", outcome: "replied" });
    expect(page.turns[0]!.occurred_at).toEqual(new Date("2026-10-03T16:11:00Z"));
  });

  it("never returns another thread's turns, with or without a topic or a window", async () => {
    const mine = newThread();
    const theirs = newThread();
    await recordConversationTurn(mine, turn({ at: "2026-10-03T08:00:00Z", user_input: "my visa question" }));
    await recordConversationTurn(theirs, turn({ at: "2026-10-03T09:00:00Z", user_input: "their visa secret" }));
    for (const query of [
      { terms: [] },
      { terms: ["visa"] },
      { terms: [], since: new Date("2026-10-03T00:00:00Z"), until: new Date("2026-10-04T00:00:00Z") },
    ]) {
      const page = await findConversationTurns({ threadId: mine, limit: 10, ...query });
      expect(page.turns.map((t) => t.user_input)).toEqual(["my visa question"]);
      expect(page.total).toBe(1);
    }
  });

  it("treats the window as [since, until): a turn at the upper bound belongs to the next window", async () => {
    const thread = newThread();
    await recordConversationTurn(thread, turn({ at: "2026-10-03T00:00:00Z", user_input: "at the start" }));
    await recordConversationTurn(thread, turn({ at: "2026-10-03T23:59:59Z", user_input: "at the end" }));
    await recordConversationTurn(thread, turn({ at: "2026-10-04T00:00:00Z", user_input: "next day" }));
    const page = await findConversationTurns({
      threadId: thread,
      since: new Date("2026-10-03T00:00:00Z"),
      until: new Date("2026-10-04T00:00:00Z"),
      terms: [],
      limit: 10,
    });
    expect(page.turns.map((t) => t.user_input).sort()).toEqual(["at the end", "at the start"]);
  });

  it("matches a topic word in the founder's message or in the reply, case-insensitively", async () => {
    const thread = newThread();
    await recordConversationTurn(thread, turn({ at: "2026-10-01T08:00:00Z", user_input: "VISA paperwork update?", reply: "No change." }));
    await recordConversationTurn(thread, turn({ at: "2026-10-02T08:00:00Z", user_input: "anything new?", reply: "Your visa interview is booked." }));
    await recordConversationTurn(thread, turn({ at: "2026-10-03T08:00:00Z", user_input: "what's for lunch", reply: "No idea." }));
    const page = await findConversationTurns({ threadId: thread, terms: ["visa"], limit: 10 });
    expect(page.total).toBe(2);
    expect(page.turns.map((t) => t.user_input)).toEqual(["anything new?", "VISA paperwork update?"]);
  });

  it("ranks a turn that matches more of the topic words above a more recent one that matches fewer", async () => {
    const thread = newThread();
    await recordConversationTurn(thread, turn({ at: "2026-10-01T08:00:00Z", user_input: "visa paperwork status", reply: "Pending." }));
    await recordConversationTurn(thread, turn({ at: "2026-10-03T08:00:00Z", user_input: "visa only", reply: "Pending." }));
    const page = await findConversationTurns({ threadId: thread, terms: ["visa", "paperwork"], limit: 10 });
    expect(page.turns.map((t) => t.user_input)).toEqual(["visa paperwork status", "visa only"]);
  });

  it("returns the latest `limit` turns but counts every match", async () => {
    const thread = newThread();
    for (let i = 0; i < 8; i++) {
      await recordConversationTurn(thread, turn({ at: `2026-10-03T0${i}:00:00Z`, user_input: `msg ${i}` }));
    }
    const page = await findConversationTurns({ threadId: thread, terms: [], limit: 3 });
    expect(page.total).toBe(8);
    expect(page.turns.map((t) => t.user_input)).toEqual(["msg 7", "msg 6", "msg 5"]);
  });

  it("matches LIKE wildcards in a term literally", async () => {
    const thread = newThread();
    await recordConversationTurn(thread, turn({ at: "2026-10-03T08:00:00Z", user_input: "plan a_b done" }));
    await recordConversationTurn(thread, turn({ at: "2026-10-03T09:00:00Z", user_input: "plan axb done" }));
    const page = await findConversationTurns({ threadId: thread, terms: ["a_b"], limit: 10 });
    expect(page.turns.map((t) => t.user_input)).toEqual(["plan a_b done"]);
  });

  it("reports the earliest saved turn of a thread, and null for a thread with none", async () => {
    const thread = newThread();
    expect(await earliestConversationTurn(thread)).toBeNull();
    await recordConversationTurn(thread, turn({ at: "2026-10-03T08:00:00Z" }));
    await recordConversationTurn(thread, turn({ at: "2026-09-30T08:00:00Z" }));
    expect(await earliestConversationTurn(thread)).toEqual(new Date("2026-09-30T08:00:00Z"));
  });
});
