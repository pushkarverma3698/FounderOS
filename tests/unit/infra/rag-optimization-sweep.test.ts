import { describe, expect, it } from "vitest";
import { renderRagReport } from "../../../src/infra/rag-optimization-sweep.js";

describe("renderRagReport (pure renderer)", () => {
  it("renders a loud failure banner when the DB query fails (D1 fix)", () => {
    const html = renderRagReport({ ok: false, reason: "connect ECONNREFUSED 127.0.0.1:5432" });

    expect(html).toContain("The check DID NOT RUN");
    expect(html).toContain("ECONNREFUSED");
    expect(html).not.toContain("optimal");
  });

  it("renders an empty-store warning when totalChunks is 0", () => {
    const html = renderRagReport({
      ok: true,
      report: { totalChunks: 0, nullEmbeddings: 0, unindexedEntries: 0, coveragePercent: 0 },
    });

    expect(html).toContain("The vector store is EMPTY");
    expect(html).toContain("0 chunks");
  });

  it("renders an actionable warning when there are unembedded chunks (D2 fix)", () => {
    const html = renderRagReport({
      ok: true,
      report: { totalChunks: 100, nullEmbeddings: 15, unindexedEntries: 5, coveragePercent: 85 },
    });

    expect(html).toContain("Total Vector Chunks: <b>100</b>");
    expect(html).toContain("Embedding Coverage: <b>85%</b>");
    expect(html).toContain("20 item(s) are stored but NOT embedded");
    expect(html).not.toContain("/sync_brain"); // Dead CTA removed
  });

  it("renders a clean confirmation when all chunks are embedded", () => {
    const html = renderRagReport({
      ok: true,
      report: { totalChunks: 200, nullEmbeddings: 0, unindexedEntries: 0, coveragePercent: 100 },
    });

    expect(html).toContain("Every stored chunk is embedded and retrievable");
  });
});
