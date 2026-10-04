/**
 * `search_memory` type "conversations" against the REAL turn log (skipped when DATABASE_URL is unreachable, like the
 * other suites here). The unit suite fakes the reader, so it cannot show that the thread scoping holds on real rows.
 *
 *   DATABASE_URL=postgresql://…/dev ALLOW_NETWORK=1 \
 *     pnpm vitest run --config vitest.integration.config.ts tests/integration/search-memory-conversations-postgres.test.ts
 *
 * Every row is filed under thread ids no other test uses and removed afterwards: TEST cleanup of rows this file created.
 */

import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { inArray } from "drizzle-orm";
import { closeDatabaseConnections, getDb } from "../../src/db/client.js";
import { conversationTurns } from "../../src/db/schema.js";
import { recordConversationTurn } from "../../src/db/conversation-turns.js";

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
  console.warn("[search-memory-conversations-postgres] SKIP: Postgres unreachable at DATABASE_URL");
}

const threads: string[] = [];

afterAll(async () => {
  if (!pgUp) return;
  if (threads.length > 0) await getDb().delete(conversationTurns).where(inArray(conversationTurns.thread_id, threads));
  await closeDatabaseConnections();
});

describe.runIf(pgUp)("search_memory conversations — real turn log", () => {
  it("returns this chat's turns and none from another chat", async () => {
    const mine = `t-int-${randomUUID()}`;
    const theirs = `t-int-${randomUUID()}`;
    threads.push(mine, theirs);
    const turn = (user_input: string) => ({
      turn_id: randomUUID(),
      at: "2026-10-03T08:00:00Z",
      user_input,
      goal: "chat",
      outcome: "replied" as const,
      reply: "Noted.",
    });
    await recordConversationTurn(mine, turn("remind me about the passport renewal"));
    await recordConversationTurn(theirs, turn("the passport secret from the other chat"));

    const { searchMemoryTool } = await import("../../src/tools/memory.js");
    const out = String(
      await searchMemoryTool.invoke(
        { query: "passport", type: "conversations" },
        { configurable: { thread_id: mine } },
      ),
    );

    expect(out).toContain("passport renewal");
    expect(out).not.toContain("other chat");
  });

  it("refuses to search conversations when the run has no chat (the IDE MCP path)", async () => {
    const { searchMemoryTool } = await import("../../src/tools/memory.js");
    const out = String(await searchMemoryTool.invoke({ query: "passport", type: "conversations" }));
    expect(out).toContain("I can't tell which chat this is");
    expect(out).not.toContain("passport renewal");
  });
});
