/**
 * Unit tests for /signals and /runs pure formatters.
 */

import { describe, it, expect } from "vitest";
import {
  formatSignalsMessage,
  formatRunsMessage,
  parseRunsLimit,
  DEFAULT_RUNS_LIMIT,
  MAX_RUNS_LIMIT,
} from "../../../src/gateway/pipeline-format.js";
import type { DeptSignal } from "../../../src/db/schema.js";

function signal(overrides: Partial<DeptSignal> = {}): DeptSignal {
  return {
    id: "s1",
    tenant_id: "turicks",
    from_dept: "research",
    to_dept: "sales",
    event_type: "lead_discovered",
    payload: { company: "Acme", icpScore: 85, source: "outbound_batch" },
    thread_id: null,
    consumed: false,
    created_at: new Date(Date.now() - 5 * 60_000),
    ...overrides,
  } as DeptSignal;
}

describe("parseRunsLimit", () => {
  it("defaults when arg is empty", () => {
    expect(parseRunsLimit(undefined)).toBe(DEFAULT_RUNS_LIMIT);
    expect(parseRunsLimit("")).toBe(DEFAULT_RUNS_LIMIT);
  });

  it("parses a numeric limit", () => {
    expect(parseRunsLimit("15")).toBe(15);
  });

  it("clamps above MAX_RUNS_LIMIT", () => {
    expect(parseRunsLimit("100")).toBe(MAX_RUNS_LIMIT);
  });

  it("falls back on invalid input", () => {
    expect(parseRunsLimit("abc")).toBe(DEFAULT_RUNS_LIMIT);
    expect(parseRunsLimit("0")).toBe(DEFAULT_RUNS_LIMIT);
  });
});

describe("formatSignalsMessage", () => {
  it("shows empty state when no signals", () => {
    const msg = formatSignalsMessage([]);
    expect(msg).toMatch(/no pending signals/i);
    expect(msg).toContain("/outbound");
  });

  it("lists pending signals with event type and company", () => {
    const msg = formatSignalsMessage([signal()]);
    expect(msg).toContain("lead_discovered");
    expect(msg).toContain("Acme");
    expect(msg).toContain("ICP 85");
    expect(msg).toContain("outbound_batch");
    expect(msg).toMatch(/\/q sales/i);
  });

  it("pluralises the header count", () => {
    const msg = formatSignalsMessage([signal(), signal({ id: "s2", payload: { company: "Beta" } })]);
    expect(msg).toContain("(2 pending)");
  });
});

describe("formatRunsMessage", () => {
  it("shows today spend and empty calls", () => {
    const msg = formatRunsMessage(0.0123, []);
    expect(msg).toContain("$0.0123");
    expect(msg).toMatch(/no llm calls/i);
  });

  it("lists recent calls with agent and cost", () => {
    const msg = formatRunsMessage(0.05, [
      {
        agent: "research",
        model: "gemini-2.5-flash",
        tokens_in: 1000,
        tokens_out: 200,
        cost_usd: "0.001500",
        created_at: new Date(),
      },
    ]);
    expect(msg).toContain("research");
    expect(msg).toContain("1,200 tok");
    expect(msg).toContain("$0.0015");
  });
});
