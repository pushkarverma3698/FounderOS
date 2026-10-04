/**
 * Brain search and the turn-log search against REAL Postgres + pgvector (skipped when DATABASE_URL is unreachable,
 * like the other suites here). The unit suites mock the database, so they cannot catch SQL that Postgres rejects.
 *
 * What this proves that they cannot:
 *   - `status NOT IN ('SUPERSEDED', 'ARCHIVED')` runs on brain_memories, in the vector query and in the keyword query,
 *     and leaves ACTIVE and STALE rows alone;
 *   - the clause is not appended for tables that have no `status` column (research_cache), which would be a
 *     "column does not exist" error in prod;
 *   - the recency weighting reorders what the real queries return, and never ages an undated document.
 *
 *   DATABASE_URL=postgresql://…/dev ALLOW_NETWORK=1 \
 *     pnpm vitest run --config vitest.integration.config.ts tests/integration/rag-status-recency-postgres.test.ts
 *
 * Every row is filed under a project tag or thread id no other test uses and removed afterwards: TEST cleanup of rows
 * this file created.
 */

import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { inArray } from "drizzle-orm";
import { closeDatabaseConnections, getDb } from "../../src/db/client.js";
import { brainMemories } from "../../src/db/schema.js";
import { hybridRagSearch } from "../../src/db/rag-hybrid.js";
import { keywordSearchRagTable, searchRagTable } from "../../src/db/rag-search.js";

async function postgresReachable(): Promise<boolean> {
  const url = process.env["DATABASE_URL"];
  if (!url) return false;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {}); // allow-failopen: a failed disconnect of the probe connection changes nothing
  }
}

const pgUp = await postgresReachable();
if (!pgUp) {
  // eslint-disable-next-line no-console
  console.warn("[rag-status-recency-postgres] SKIP: Postgres unreachable at DATABASE_URL");
}

const projects: string[] = [];
const newProject = (): string => {
  const id = `t-int-${randomUUID()}`;
  projects.push(id);
  return id;
};

// Every row gets the same embedding, so the vector side ties and only status / recency can separate them.
const VEC = [1, ...Array<number>(767).fill(0)];
const MARKER = "zqxjkw"; // a token no real document contains, so the keyword side matches only this file's rows

async function seed(
  project: string,
  rows: Array<{ label: string; status?: string; sourcePath?: string }>,
): Promise<void> {
  await getDb()
    .insert(brainMemories)
    .values(
      rows.map((r) => ({
        memory_type: "document",
        content: `${MARKER} ${r.label}`,
        embedding: VEC,
        project,
        status: r.status ?? "ACTIVE",
        metadata: r.sourcePath ? { source_path: r.sourcePath } : {},
      })),
    );
}

afterAll(async () => {
  if (!pgUp) return;
  if (projects.length > 0) await getDb().delete(brainMemories).where(inArray(brainMemories.project, projects));
  await closeDatabaseConnections();
});

describe.runIf(pgUp)("brain_memories status filter — real Postgres", () => {
  it("leaves SUPERSEDED and ARCHIVED rows out of both the vector and the keyword query, keeps ACTIVE and STALE", async () => {
    const project = newProject();
    await seed(project, [
      { label: "active", status: "ACTIVE" },
      { label: "stale", status: "STALE" },
      { label: "superseded", status: "SUPERSEDED" },
      { label: "archived", status: "ARCHIVED" },
    ]);
    const labels = (hits: Array<{ content: string }>): string[] =>
      hits.map((h) => h.content.replace(`${MARKER} `, "")).sort();

    const vector = await searchRagTable("brain_memories", VEC, 10, { filter: { project } });
    const keyword = await keywordSearchRagTable("brain_memories", MARKER, 10, { filter: { project } });

    expect(labels(vector)).toEqual(["active", "stale"]);
    expect(labels(keyword)).toEqual(["active", "stale"]);
  });

  it("does not append the status clause to tables that have no status column", async () => {
    // research_cache has no `status` column: a clause meant for brain_memories there is a Postgres error in prod.
    await expect(searchRagTable("research_cache", VEC, 3)).resolves.toBeInstanceOf(Array);
    await expect(keywordSearchRagTable("research_cache", MARKER, 3)).resolves.toBeInstanceOf(Array);
  });
});

describe.runIf(pgUp)("recency weighting on real query results", () => {
  const NOW = Date.parse("2026-10-04T12:00:00Z");
  const real = (project: string) => ({
    vectorSearch: (t: Parameters<typeof searchRagTable>[0], _q: string, k: number) =>
      searchRagTable(t, VEC, k, { filter: { project } }),
    keywordSearch: (t: Parameters<typeof keywordSearchRagTable>[0], q: string, k: number) =>
      keywordSearchRagTable(t, q, k, { filter: { project } }),
    now: () => NOW,
  });

  it("puts a recently dated document above an old one the real queries tied, and never ages an undated one", async () => {
    const project = newProject();
    await seed(project, [
      { label: "old", sourcePath: "docs/plans/2025-01-01-old.md" },
      { label: "new", sourcePath: "docs/plans/2026-10-03-new.md" },
      { label: "undated", sourcePath: "docs/decisions/ADR-013-firewall.md" },
    ]);

    const result = await hybridRagSearch("brain_memories", MARKER, 10, real(project));
    if ("error" in result) throw new Error(`search failed: ${result.error.message}`);

    const order = result.hits.map((h) => h.content.replace(`${MARKER} `, ""));
    expect(result.mode).toBe("hybrid");
    expect(order).toHaveLength(3);
    // Equal embeddings and equal term overlap: the old plan is the only one the weighting can push down.
    expect(order[2]).toBe("old");
    expect(order.slice(0, 2).sort()).toEqual(["new", "undated"]);
  });

  it("keeps a superseded document out of the fused result however recent it is", async () => {
    const project = newProject();
    await seed(project, [
      { label: "current", sourcePath: "docs/plans/2026-09-01-current.md" },
      { label: "replaced", status: "SUPERSEDED", sourcePath: "docs/plans/2026-10-03-replaced.md" },
    ]);

    const result = await hybridRagSearch("brain_memories", MARKER, 10, real(project));
    if ("error" in result) throw new Error(`search failed: ${result.error.message}`);
    expect(result.hits.map((h) => h.content.replace(`${MARKER} `, ""))).toEqual(["current"]);
  });
});
