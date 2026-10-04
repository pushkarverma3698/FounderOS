/**
 * The shape of the SQL `findConversationTurns` sends, without a database.
 *
 * Postgres reads `ORDER BY 0` as "column number 0" and rejects it ("ORDER BY position 0 is not in select list").
 * With no topic words the ranking expression used to be the constant 0, so every "what did I ask yesterday?" (a time
 * window and no topic) failed in production while the mocked recall tests passed. The real-Postgres suite
 * (tests/integration/conversation-turns-postgres.test.ts) proves the behaviour; this keeps the shape in the default run.
 */

import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const orderByCalls: unknown[][] = [];

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          // the rows query ends in orderBy(...).limit(); the count query is awaited straight after where()
          orderBy: (...keys: unknown[]) => {
            orderByCalls.push(keys);
            return { limit: async () => [] };
          },
          then: (resolve: (rows: unknown[]) => unknown) => resolve([{ n: 0 }]),
        }),
      }),
    }),
  }),
}));

const { findConversationTurns } = await import("../../../src/db/conversation-turns.js");

const dialect = new PgDialect();
const sortKeysSql = (keys: unknown[]): string[] => keys.map((k) => dialect.sqlToQuery(k as SQL).sql.trim());

async function sortKeys(terms: string[]): Promise<string[]> {
  orderByCalls.length = 0;
  await findConversationTurns({ threadId: "turicks:1", terms, limit: 5 });
  expect(orderByCalls).toHaveLength(1);
  return sortKeysSql(orderByCalls[0]!);
}

describe("findConversationTurns sort keys", () => {
  it("never sorts by a bare constant (Postgres reads it as a column position)", async () => {
    for (const terms of [[], ["visa"], ["visa", "paperwork"]]) {
      const keys = await sortKeys(terms);
      for (const key of keys) expect(key, `terms=${JSON.stringify(terms)}`).not.toMatch(/^\d+(\s|$)/);
    }
  });

  it("with no topic sorts by time alone, newest first", async () => {
    const keys = await sortKeys([]);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/occurred_at"? desc$/);
  });

  it("with a topic ranks by how many words matched, then by time", async () => {
    const keys = await sortKeys(["visa", "paperwork"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toContain("CASE WHEN");
    expect(keys[1]).toMatch(/occurred_at"? desc$/);
  });
});
