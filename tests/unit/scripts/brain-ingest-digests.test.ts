/**
 * VPS ingester (AG-027). Injected deps, no database. Secret-shaped strings are assembled at run time.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../src/db/client.js", () => ({ db: {} }));
const { ingestDigests, summaryText, toIngestOptions } = await import("../../../scripts/brain-ingest-digests.js");
import type { IngestOptions } from "../../../src/db/brain-ingest.js";

const FAKE_KEY = ["ghp", "B".repeat(36)].join("_");

const rec = (id: string, over: Record<string, unknown> = {}) => ({
  source: "mac-claude", source_id: id, memory_type: "session", project: "founderos", content: `digest ${id}`,
  metadata: {
    origin: "mac-claude", client: "claude-code", machine: "m", session_id: id, repo: "founderos",
    occurred_at: "2026-10-06T04:00:00.000Z", visibility: "founder", title: "t", branch: "b",
  },
  ...over,
});
const manifest = (ids: string[]) => ({
  source: "mac-claude", source_id: "manifest:p", memory_type: "claude_manifest", project: null, content: "",
  metadata: { slug: "p", source_ids: ids },
});
const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n");

function deps(outcomes: Array<"inserted" | "updated" | "unchanged"> = []) {
  const calls: IngestOptions[] = [];
  return {
    calls,
    ingest: vi.fn(async (o: IngestOptions) => {
      calls.push(o);
      return { outcome: outcomes.shift() ?? ("inserted" as const) };
    }),
    archive: vi.fn(async () => 2),
  };
}

describe("toIngestOptions", () => {
  it("splits AG-026 provenance from the extra metadata and keeps visibility founder", () => {
    const opts = toIngestOptions(rec("s1") as never);
    expect(opts.provenance).toMatchObject({ origin: "mac-claude", visibility: "founder", session_id: "s1", repo: "founderos" });
    expect(opts.metadata).toEqual({ title: "t", branch: "b" });
    expect(opts).toMatchObject({ memoryType: "session", source: "mac-claude", sourceId: "s1", project: "founderos" });
  });
});

describe("ingestDigests", () => {
  it("ingests valid records, counts unchanged as skipped, and archives from the manifest", async () => {
    const d = deps(["inserted", "unchanged"]);
    const s = await ingestDigests(jsonl(rec("a"), rec("b"), manifest(["x"])), d);
    expect(s).toMatchObject({ ingested: 1, skipped: 1, archived: 2, droppedForSecrets: 0, failed: 0 });
    expect(d.archive).toHaveBeenCalledTimes(1);
    expect(summaryText(s)).toBe("ingested 1, skipped 1, archived 2, dropped-for-secrets 0");
  });

  it("re-scrubs on the VPS: a record with a secret is dropped even though the Mac sent it", async () => {
    const d = deps();
    const s = await ingestDigests(jsonl(rec("bad", { content: `key ${FAKE_KEY}` }), rec("ok")), d);
    expect(d.calls.map((c) => c.sourceId)).toEqual(["ok"]);
    expect(s.droppedForSecrets).toBe(1);
    expect(s.dropped).toEqual(["mac-claude:bad"]);
    expect(JSON.stringify(s)).not.toContain(FAKE_KEY);
  });

  it("validates with Zod: malformed lines and a non-founder visibility count as skipped, not ingested", async () => {
    const d = deps();
    const wrongVisibility = rec("v", { metadata: { ...rec("v").metadata, visibility: "all" } });
    const s = await ingestDigests(["not json", jsonl({ nope: 1 }), jsonl(wrongVisibility), jsonl(rec("ok"))].join("\n"), d);
    expect(d.calls).toHaveLength(1);
    expect(s.skipped).toBe(3);
  });

  it("caps the records per run and reports the overflow as skipped", async () => {
    const d = deps();
    const s = await ingestDigests(jsonl(rec("1"), rec("2"), rec("3")), d, 2);
    expect(d.calls).toHaveLength(2);
    expect(s.skipped).toBe(1);
  });

  it("does not archive after a failed write, and says FAILED so the wrapper keeps its state", async () => {
    const d = deps();
    d.ingest.mockRejectedValueOnce(new Error("embed down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const s = await ingestDigests(jsonl(rec("a"), manifest(["x"])), d);
    err.mockRestore();
    expect(s.failed).toBe(1);
    expect(d.archive).not.toHaveBeenCalled();
    expect(summaryText(s)).toContain("FAILED 1");
  });

  it("empty input is a clean no-op", async () => {
    const s = await ingestDigests("", deps());
    expect(summaryText(s)).toBe("ingested 0, skipped 0, archived 0, dropped-for-secrets 0");
  });
});
