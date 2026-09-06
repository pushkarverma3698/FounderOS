/**
 * searchBrain failure attribution (ADR-038's single retrieval entry point).
 *
 * 2026-09-06, found by driving the IDE brain MCP for real: with the local
 * Postgres container down, `search_memory` answered
 *   "Search failed at stage embed: "
 * Two defects in one line. The embedder was up (Ollama, nomic-embed-text,
 * verified) — the database was the failure, but `searchBrain` wraps embed AND
 * the vector query in a single try and tags everything `embed`. And the message
 * was blank, because a refused TCP connect arrives as an AggregateError.
 *
 * The stage is not cosmetic: it is what tells the founder whether to start
 * Ollama or start Postgres. Naming the wrong component sends the fix at the
 * wrong subsystem, which is exactly what CLAUDE.md's FailureReport rule exists
 * to prevent.
 *
 * $0 — the DB client and the embedder are both mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const execute = vi.fn();
const embedText = vi.fn();

vi.mock("../../../src/db/client.js", () => ({ db: { execute } }));
vi.mock("../../../src/lib/embed.js", () => ({ embedText }));

const { searchBrain } = await import("../../../src/db/rag-search.js");

/** A refused Postgres connect, exactly as Node surfaces it (message: ""). */
function refusedConnect(): AggregateError {
  return new AggregateError([
    new Error("connect ECONNREFUSED ::1:5432"),
    new Error("connect ECONNREFUSED 127.0.0.1:5432"),
  ]);
}

describe("searchBrain — failure names the component that actually failed", () => {
  beforeEach(() => {
    execute.mockReset();
    embedText.mockReset();
  });

  it("attributes a dead embedder to the embed stage", async () => {
    embedText.mockRejectedValue(
      new Error("Ollama embeddings unreachable at http://localhost:11434"),
    );
    execute.mockRejectedValue(refusedConnect());

    const res = await searchBrain({ query: "branch naming grammar", topK: 3 });
    if (!("error" in res)) throw new Error("expected error");
    expect(res.error.stage).toBe("embed");
    expect(res.error.message).toMatch(/ollama/i);
  });

  it("attributes a dead database to the query stage, not the embedder", async () => {
    embedText.mockResolvedValue(new Array(768).fill(0.01));
    execute.mockRejectedValue(refusedConnect());

    const res = await searchBrain({ query: "branch naming grammar", topK: 3 });
    if (!("error" in res)) throw new Error("expected error");
    expect(res.error.stage).toBe("query");
  });

  it("never reports a blank reason, whatever the underlying error shape", async () => {
    embedText.mockResolvedValue(new Array(768).fill(0.01));
    execute.mockRejectedValue(refusedConnect());

    // A real multi-term query: the keyword path drops sub-2-char terms and would
    // otherwise answer [] without ever touching the (dead) database.
    const res = await searchBrain({ query: "postgres brain retrieval", topK: 3 });
    if (!("error" in res)) throw new Error("expected error");
    expect(res.error.message).not.toBe("");
    expect(res.error.message).toMatch(/ECONNREFUSED/);
  });
});
