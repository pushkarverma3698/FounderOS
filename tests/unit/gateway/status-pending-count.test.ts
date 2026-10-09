/**
 * /status counts only approvals the founder can still act on (issue #1061).
 * ===========================================================================
 * On 10-09 /status said "4 pending": all four were eval:* threads from `pnpm eval`, and expired ones counted too.
 * The DB is mocked; this pins the WHERE clause the count runs with, rendered by drizzle's Postgres dialect.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const wheres: SQL[] = [];
vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: (w: SQL) => {
          wheres.push(w);
          return Promise.resolve([{ total: 0 }]);
        },
      }),
    }),
  }),
}));

const { getSystemStatus } = await import("../../../src/gateway/status.js");
const dialect = new PgDialect();

beforeEach(() => {
  wheres.length = 0;
});

describe("getSystemStatus — pending approvals", () => {
  it("excludes eval threads and expired rows", async () => {
    await getSystemStatus();
    const { sql, params } = dialect.sqlToQuery(wheres[0]!);
    expect(sql).toMatch(/"status" = \$\d/);
    expect(sql).toMatch(/"thread_id" not like \$\d/);
    expect(sql).toMatch(/"expires_at" > \$\d/);
    expect(params).toContain("pending");
    expect(params).toContain("eval:%");
  });
});
