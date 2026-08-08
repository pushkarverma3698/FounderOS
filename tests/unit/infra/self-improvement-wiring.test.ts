/**
 * Unit tests — the self-improvement sensors are wired AND cannot fake health.
 * =========================================================================
 * Before this file, the entire cron layer had zero coverage: `startScheduler`,
 * the weekly RAG sweep and the 3-day self-audit were all unverified. Two of them
 * shared one defect — the failure path rendered as an all-clear:
 *
 *   - `inspectRagHealth` swallowed a dead Postgres and returned
 *     `{0, 0, 0, coveragePercent: 100}`, which printed
 *     "✅ RAG vector database is optimal."
 *   - `runSelfAudit` (the CRON path) dropped `skippedReason`, so only a human
 *     running the CLI ever saw "TELEMETRY SKIPPED".
 *
 * These tests exist to keep "did not run" and "came back clean" distinguishable.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSendToChat = vi.fn(async () => {});
vi.mock("../../../src/infra/telegram-send.js", () => ({ sendToChat: mockSendToChat }));

const mockExecute = vi.fn();
vi.mock("../../../src/db/client.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, getDb: () => ({ execute: mockExecute }) };
});

const { inspectRagHealth, renderRagReport, runRagOptimizationSweep } = await import(
  "../../../src/infra/rag-optimization-sweep.js"
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("renderRagReport — a check that did not run never reads as healthy", () => {
  it("reports a DB failure as NOT RUN, never as optimal", () => {
    const out = renderRagReport({ ok: false, reason: "ECONNREFUSED 127.0.0.1:5432" });

    expect(out).toContain("DID NOT RUN");
    expect(out).toContain("ECONNREFUSED 127.0.0.1:5432");
    expect(out).toContain("UNKNOWN");
    // The exact regression: an outage must never render the all-clear.
    expect(out).not.toContain("✅");
    expect(out).not.toMatch(/optimal/i);
  });

  it("escapes HTML in the failure reason so the report cannot break the send", () => {
    const out = renderRagReport({ ok: false, reason: 'relation "a<b>" & c' });

    expect(out).toContain("&lt;b&gt;");
    expect(out).toContain("&amp;");
  });

  it("reports an EMPTY store as empty, not as 100% coverage", () => {
    const out = renderRagReport({
      ok: true,
      report: { totalChunks: 0, nullEmbeddings: 0, unindexedEntries: 0, coveragePercent: 0 },
    });

    expect(out).toMatch(/EMPTY/);
    expect(out).not.toContain("100%");
    expect(out).not.toContain("✅");
  });

  it("names a real command when items need embedding — never the nonexistent /sync_brain", () => {
    const out = renderRagReport({
      ok: true,
      report: { totalChunks: 100, nullEmbeddings: 3, unindexedEntries: 2, coveragePercent: 97 },
    });

    expect(out).toContain("5 item(s)");
    expect(out).toContain("pnpm brain:sync");
    // `/sync_brain` was never registered in src/gateway/telegram.ts.
    expect(out).not.toContain("/sync_brain");
  });

  it("gives the all-clear only when there is real data and nothing pending", () => {
    const out = renderRagReport({
      ok: true,
      report: { totalChunks: 384, nullEmbeddings: 0, unindexedEntries: 0, coveragePercent: 100 },
    });

    expect(out).toContain("✅");
    expect(out).toContain("384");
  });
});

describe("inspectRagHealth — the collector encodes failure in its return type", () => {
  it("returns ok:false with the reason when the database throws", async () => {
    mockExecute.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    const result = await inspectRagHealth();

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("ECONNREFUSED");
  });

  it("returns ok:false when the query yields no rows", async () => {
    mockExecute.mockResolvedValueOnce([]);

    const result = await inspectRagHealth();

    expect(result.ok).toBe(false);
  });

  it("computes coverage from real rows", async () => {
    mockExecute.mockResolvedValueOnce([
      { total_chunks: 200, null_embeddings: 50, unindexed_entries: 7 },
    ]);

    const result = await inspectRagHealth();

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.report.coveragePercent).toBe(75);
    expect(result.ok === true && result.report.unindexedEntries).toBe(7);
  });
});

describe("runRagOptimizationSweep — the founder is told when the sensor is blind", () => {
  it("still sends a message on DB failure, and it says the check did not run", async () => {
    mockExecute.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    await runRagOptimizationSweep();

    expect(mockSendToChat).toHaveBeenCalledTimes(1);
    const [text] = mockSendToChat.mock.calls[0] as unknown as [string];
    expect(text).toContain("DID NOT RUN");
    expect(text).not.toMatch(/optimal/i);
  });
});
