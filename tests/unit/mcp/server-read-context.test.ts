/**
 * MCP read_context must return the founder's stored context.
 * ===========================================================
 * The handler serialised `ctx.context_data`, but getFounderContext returns the
 * stored JSON object itself: there is no `context_data` key, so every call
 * answered with `undefined`. Its `if (!ctx)` empty check could never fire
 * either, because `{}` is truthy. The existing server.test.ts case only
 * asserted "some text content came back", which `undefined` satisfied.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetFounderContext = vi.fn(async (): Promise<Record<string, unknown>> => ({}));

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, getFounderContext: mockGetFounderContext };
});

const { handleMcpToolCall } = await import("../../../src/mcp/server.js");

async function readContextText(): Promise<string | undefined> {
  const result = await handleMcpToolCall("read_context", {});
  expect(result.isError).toBeFalsy();
  return result.content[0]?.text;
}

describe("MCP read_context", () => {
  beforeEach(() => {
    mockGetFounderContext.mockReset();
  });

  it("returns the stored context, not undefined", async () => {
    mockGetFounderContext.mockResolvedValue({
      current_priorities: ["Close the Acme pilot this week"],
      active_clients: ["Acme"],
      last_updated: "2026-09-27T09:15:00.000Z",
    });

    const text = await readContextText();

    expect(text).toBeTypeOf("string");
    expect(text).not.toBe("undefined");
    expect(JSON.parse(text ?? "")).toEqual({
      current_priorities: ["Close the Acme pilot this week"],
      active_clients: ["Acme"],
      last_updated: "2026-09-27T09:15:00.000Z",
    });
  });

  it("says no context is saved when the row is empty", async () => {
    mockGetFounderContext.mockResolvedValue({});
    expect(await readContextText()).toMatch(/no context saved yet/i);
  });

  it("excludes internal bookkeeping keys", async () => {
    mockGetFounderContext.mockResolvedValue({
      current_priorities: ["Ship the proof page"],
      budget_alerts_sent: { date: "2026-09-28", levels: [80] },
    });

    const text = await readContextText();

    expect(text).not.toContain("budget_alerts_sent");
    expect(JSON.parse(text ?? "")).toEqual({ current_priorities: ["Ship the proof page"] });
  });

  it("treats a row holding only bookkeeping as no context saved", async () => {
    mockGetFounderContext.mockResolvedValue({
      budget_alerts_sent: { date: "2026-09-28", levels: [80, 100] },
      last_updated: "2026-09-28T07:00:00.000Z",
    });
    expect(await readContextText()).toMatch(/no context saved yet/i);
  });

  it("reports an unavailable database instead of throwing", async () => {
    mockGetFounderContext.mockRejectedValue(new Error("connect ECONNREFUSED"));
    expect(await readContextText()).toMatch(/context unavailable/i);
  });
});
