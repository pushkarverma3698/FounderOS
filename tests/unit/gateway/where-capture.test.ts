import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../../src/db/client.js", () => ({ db: { execute } }));
const { fetchCaptureStatus, renderCaptureLine, CAPTURE_STALE_MS } = await import("../../../src/db/brain-capture-status.js");
const { handleWhere } = await import("../../../src/gateway/where-command.js");

const NOW = new Date("2026-10-06T12:00:00Z");

describe("renderCaptureLine", () => {
  it("shows minutes since the last row and rows today, no warning when fresh", () => {
    const line = renderCaptureLine({ lastAt: new Date(NOW.getTime() - 25 * 60_000), rowsToday: 7 }, NOW);
    expect(line).toBe("Mac capture: last 25 min ago, 7 rows today");
  });

  it("warns once the last capture is older than two hours", () => {
    const line = renderCaptureLine({ lastAt: new Date(NOW.getTime() - CAPTURE_STALE_MS - 60_000), rowsToday: 0 }, NOW);
    expect(line).toContain("⚠️");
    expect(line).toContain("121 min ago");
  });

  it("does not warn at exactly two hours", () => {
    expect(renderCaptureLine({ lastAt: new Date(NOW.getTime() - CAPTURE_STALE_MS), rowsToday: 1 }, NOW)).not.toContain("⚠️");
  });

  it("warns and says what to do when no row exists yet", () => {
    const line = renderCaptureLine({ lastAt: null, rowsToday: 0 }, NOW);
    expect(line).toContain("no rows yet");
    expect(line).toContain("⚠️");
  });
});

describe("fetchCaptureStatus", () => {
  it("queries only Mac origins and maps the row", async () => {
    execute.mockResolvedValueOnce([{ last_at: "2026-10-06T11:00:00Z", rows_today: "4" }]);
    const status = await fetchCaptureStatus("Asia/Kolkata");
    const { sql, params } = new PgDialect().sqlToQuery(execute.mock.calls.at(-1)?.[0]);
    expect(sql).toMatch(/metadata->>'origin' IN \(\$\d+, \$\d+\)/);
    expect(params).toEqual(expect.arrayContaining(["mac-claude", "mac-agy"]));
    expect(status).toEqual({ lastAt: new Date("2026-10-06T11:00:00Z"), rowsToday: 4 });
  });

  it("returns an empty status for an empty table", async () => {
    execute.mockResolvedValueOnce([{ last_at: null, rows_today: "0" }]);
    expect(await fetchCaptureStatus("Asia/Kolkata")).toEqual({ lastAt: null, rowsToday: 0 });
  });
});

describe("/where prints the capture line", () => {
  const ctx = () => {
    const reply = vi.fn(async (..._a: unknown[]) => undefined);
    return { ctx: { match: "", reply } as never, reply };
  };
  const fetch = vi.fn(async () => ({ summaries: [], unreachable: [] }));

  it("replies with the heartbeat after the repo sections", async () => {
    const { ctx: c, reply } = ctx();
    await handleWhere(c, { fetch, capture: async () => ({ lastAt: new Date(Date.now() - 10 * 60_000), rowsToday: 3 }) });
    const last = String(reply.mock.calls.at(-1)?.[0]);
    expect(last).toMatch(/^Mac capture: last \d+ min ago, 3 rows today$/);
  });

  it("says so when the status query fails, instead of omitting the line", async () => {
    const { ctx: c, reply } = ctx();
    await handleWhere(c, { fetch, capture: async () => { throw new Error("db down"); } });
    expect(String(reply.mock.calls.at(-1)?.[0])).toBe("Mac capture: status unavailable (db down)");
  });

  it("prints no capture line when no capture dependency is given", async () => {
    const { ctx: c, reply } = ctx();
    await handleWhere(c, { fetch });
    expect(reply.mock.calls.some((call) => String(call[0]).startsWith("Mac capture"))).toBe(false);
  });
});
