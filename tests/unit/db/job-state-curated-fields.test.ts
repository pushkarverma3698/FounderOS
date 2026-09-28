/**
 * queryJobState's curated rows must carry posted_at.
 * ===================================================
 * The free-text path ("any new roles today?") answers from job_state, whose
 * default (non-fullDetails) select returned created_at — when WE found the
 * row — but not posted_at, when the employer published it. On 2026-09-07 the
 * founder asked "are these of today?" four times in five minutes; the command
 * views have printed "posted X · found Y" since 09-08, and the free-text answer
 * could not, because the date was never selected.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { queryJobState } from "../../../src/db/job-queries.js";

const selected: Array<Record<string, unknown>> = [];
const POSTED = new Date("2026-09-25T08:00:00Z");
const FOUND = new Date("2026-09-28T06:00:00Z");

/** The stored row. A select returns only the columns it names, like Postgres. */
const STORED: Record<string, unknown> = {
  id: "a1",
  company: "Adyen",
  title: "FP&A Analyst",
  stage: "screened",
  posted_at: POSTED,
  created_at: FOUND,
};

vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({
    select: (fields: Record<string, unknown>) => {
      selected.push(fields);
      const isTotal = "total" in fields;
      const rows = isTotal
        ? [{ total: 1 }]
        : [Object.fromEntries(Object.keys(fields).map((k) => [k, STORED[k] ?? null]))];
      return {
        from: () => ({
          // The count query awaits .where(); the row query chains orderBy().limit().
          where: () => ({
            then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
              Promise.resolve(rows).then(resolve, reject),
            orderBy: () => ({ limit: async () => rows }),
          }),
        }),
      };
    },
  }),
}));

describe("queryJobState — curated rows", () => {
  beforeEach(() => {
    selected.length = 0;
  });

  it("selects posted_at alongside created_at", async () => {
    await queryJobState({});
    const curated = selected.find((fields) => "company" in fields);
    expect(curated).toBeDefined();
    expect(Object.keys(curated ?? {})).toEqual(expect.arrayContaining(["posted_at", "created_at"]));
  });

  it("returns both dates on each row", async () => {
    const { rows } = await queryJobState({});
    expect(rows[0]).toMatchObject({ posted_at: POSTED, created_at: FOUND });
  });
});
