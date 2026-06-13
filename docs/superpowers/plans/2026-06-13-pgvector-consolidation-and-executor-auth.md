# pgvector Consolidation + Executor Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the three knowledge stores (Postgres `knowledge_entries` + two ChromaDB/Ollama services) into one Postgres+pgvector engine with isolated tables, keep local Ollama `nomic-embed-text` for embeddings, and configure the Claude Code executor for OAuth-with-API-key-fallback on the VPS.

**Architecture:** One Postgres instance holds `knowledge_entries` (keyword + optional vector), `personal_rag` (vector, isolated), and `turicks_brain` (vector, isolated). The native systemd app embeds queries via a loopback-bound Ollama container and runs pgvector nearest-neighbour search. The two `search_*` tool contracts are unchanged so agents/prompts/graph are untouched. ChromaDB and the two Python FastAPI services are removed from production.

**Tech Stack:** Node 22, TypeScript (strict, ESM, `.js` imports), drizzle-orm + postgres.js, pgvector (`vector(768)`, HNSW cosine), Ollama `nomic-embed-text`, Docker Compose, vitest.

**Key constants (used throughout):**
- Embedding model: `nomic-embed-text` · dimensions: **768** · distance: cosine (`<=>`), score = `1 - distance`
- Ollama endpoint: `POST {OLLAMA_URL}/api/embeddings` body `{ model, prompt }` → `{ embedding: number[] }`
- Allowed RAG tables (isolation allowlist): `"personal_rag"`, `"turicks_brain"`

---

### Task 1: Config — add Ollama + executor env vars

**Files:**
- Modify: `src/core/config.ts`
- Test: `tests/unit/core/config.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/core/config.test.ts
import { describe, it, expect } from "vitest";
import { envSchema } from "../../../src/core/config.js";

describe("env config — embedding + executor vars", () => {
  it("defaults OLLAMA_URL, EMBED_MODEL, EMBED_DIM and accepts optional executor key", () => {
    const parsed = envSchema.parse({
      DATABASE_URL: "postgresql://u:p@localhost:5432/db",
      TELEGRAM_BOT_TOKEN: "x",
      TELEGRAM_CHAT_ID: "1",
    });
    expect(parsed.OLLAMA_URL).toBe("http://localhost:11434");
    expect(parsed.EMBED_MODEL).toBe("nomic-embed-text");
    expect(parsed.EMBED_DIM).toBe(768);
    expect(parsed.CLAUDE_EXECUTOR_API_KEY).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/core/config.test.ts`
Expected: FAIL — `envSchema` not exported, or new fields missing.

- [ ] **Step 3: Implement**

In `src/core/config.ts`, ensure the schema object is exported as `envSchema` and add these fields inside the `z.object({ ... })` (alongside the existing optional vars):

```typescript
  // ── Embeddings (local Ollama) ───────────────────────────────────────────
  OLLAMA_URL: z.string().url().default("http://localhost:11434"),
  EMBED_MODEL: z.string().default("nomic-embed-text"),
  EMBED_DIM: z.coerce.number().int().positive().default(768),

  // ── Claude Code executor (optional API-key fallback; OAuth used when unset) ──
  CLAUDE_EXECUTOR_API_KEY: z.string().transform(v => v || undefined).optional(),
  CLAUDE_EXECUTOR_BASE_URL: z.string().transform(v => v || undefined).optional(),
```

If the schema is currently an inline `z.object(...)` passed straight to `.parse`, extract it: `export const envSchema = z.object({ ... });` then `export const env = envSchema.parse(process.env);`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/core/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts tests/unit/core/config.test.ts
git commit -m "feat(config): add OLLAMA_URL/EMBED_MODEL/EMBED_DIM + executor API-key fallback env"
```

---

### Task 2: Schema — pgvector tables + embedding column

**Files:**
- Modify: `src/db/schema.ts`
- Create (generated, then hand-edited): `drizzle/NNNN_pgvector.sql`

- [ ] **Step 1: Add table definitions to `src/db/schema.ts`**

Add `vector` to the existing `drizzle-orm/pg-core` import line. Then append before the type-exports block:

```typescript
// ── RAG vector stores (consolidated from ChromaDB — ADR-013/015 isolation) ──
// personal_rag and turicks_brain are SEPARATE tables; the access layer
// (src/db/rag-search.ts) enforces that one tool can never read the other.

export const personalRag = pgTable(
  "personal_rag",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    embedding: vector("embedding", { dimensions: 768 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
);

export const turicksBrain = pgTable(
  "turicks_brain",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    embedding: vector("embedding", { dimensions: 768 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
);

export type PersonalRagRow = typeof personalRag.$inferSelect;
export type NewPersonalRagRow = typeof personalRag.$inferInsert;
export type TuricksBrainRow = typeof turicksBrain.$inferSelect;
export type NewTuricksBrainRow = typeof turicksBrain.$inferInsert;
```

Also add an optional embedding column to `knowledgeEntries` (inside its column block, after `metadata`):

```typescript
    /** Optional 768-dim embedding for hybrid keyword+vector search */
    embedding: vector("embedding", { dimensions: 768 }),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file `drizzle/NNNN_*.sql` is created with the new tables/column.

- [ ] **Step 3: Hand-edit the generated migration for the pgvector extension + HNSW indexes**

drizzle-kit does NOT emit `CREATE EXTENSION` or vector indexes. Open the new `drizzle/NNNN_*.sql` and:

Prepend as the very first statement:
```sql
CREATE EXTENSION IF NOT EXISTS vector;
```
Append at the end (cosine HNSW indexes for fast nearest-neighbour):
```sql
CREATE INDEX IF NOT EXISTS personal_rag_embedding_idx
  ON personal_rag USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS turicks_brain_embedding_idx
  ON turicks_brain USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS knowledge_entries_embedding_idx
  ON knowledge_entries USING hnsw (embedding vector_cosine_ops);
```

- [ ] **Step 4: Verify the migration applies (needs Postgres WITH the pgvector extension)**

The default `postgres:16-alpine` image does NOT ship pgvector, so `CREATE EXTENSION vector` will fail. Spin up a pgvector-enabled Postgres for this check (this is the same image Task 7 makes permanent):

```bash
docker rm -f founderos-postgres 2>/dev/null || true
docker run -d --name founderos-postgres -e POSTGRES_USER=founderos \
  -e POSTGRES_PASSWORD=founderos -e POSTGRES_DB=founderos \
  -p 127.0.0.1:5432:5432 pgvector/pgvector:pg16
sleep 5 && pnpm db:migrate
```
Expected: migration applies, no error. Confirm: `docker exec founderos-postgres psql -U founderos -c "\dt"` lists `personal_rag` and `turicks_brain`.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(db): add pgvector personal_rag + turicks_brain tables and embedding column"
```

---

### Task 3: Ollama embedding helper

**Files:**
- Create: `src/lib/embed.ts`
- Test: `tests/unit/lib/embed.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/lib/embed.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
const { embedText } = await import("../../../src/lib/embed.js");

describe("embedText", () => {
  beforeEach(() => mockFetch.mockReset());

  it("returns the embedding vector from Ollama", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [0.1, 0.2, 0.3] }) });
    const v = await embedText("hello");
    expect(v).toEqual([0.1, 0.2, 0.3]);
    const [, init] = mockFetch.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({ model: "nomic-embed-text", prompt: "hello" });
  });

  it("throws a clear error when Ollama is unreachable", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(embedText("x")).rejects.toThrow(/Ollama/i);
  });

  it("throws when response is missing the embedding field", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await expect(embedText("x")).rejects.toThrow(/embedding/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/lib/embed.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/embed.ts`**

```typescript
/**
 * Local embedding via Ollama (nomic-embed-text). Used for RAG query embedding.
 * RAG text never leaves the box — privacy requirement (no API egress).
 */
import { env } from "../core/config.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "lib:embed" });

interface OllamaEmbedResponse {
  embedding?: number[];
}

/** Embed a single string into a vector. Throws on failure (fail-loud). */
export async function embedText(text: string): Promise<number[]> {
  let resp: Response;
  try {
    resp = await fetch(`${env.OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: env.EMBED_MODEL, prompt: text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    log.error({ err: (err as Error).message }, "Ollama embeddings unreachable");
    throw new Error(
      `Ollama embeddings unreachable at ${env.OLLAMA_URL}. Is the ollama container up and is '${env.EMBED_MODEL}' pulled?`,
    );
  }
  if (!resp.ok) {
    throw new Error(`Ollama embeddings returned HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as OllamaEmbedResponse;
  if (!data.embedding || data.embedding.length === 0) {
    throw new Error("Ollama embeddings response missing 'embedding' field");
  }
  return data.embedding;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/lib/embed.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/embed.ts tests/unit/lib/embed.test.ts
git commit -m "feat(embed): local Ollama nomic-embed-text query embedding helper"
```

---

### Task 4: pgvector search layer + isolation guard

**Files:**
- Create: `src/db/rag-search.ts`
- Test: `tests/unit/db/rag-search.test.ts`

- [ ] **Step 1: Write the failing test (pure guard + SQL-shape logic)**

```typescript
// tests/unit/db/rag-search.test.ts
import { describe, it, expect } from "vitest";
import { assertAllowedRagTable, ALLOWED_RAG_TABLES } from "../../../src/db/rag-search.js";

describe("rag-search isolation guard", () => {
  it("allows the two known RAG tables", () => {
    expect(() => assertAllowedRagTable("personal_rag")).not.toThrow();
    expect(() => assertAllowedRagTable("turicks_brain")).not.toThrow();
  });

  it("rejects any other table name (ADR-013/015 cross-store ban + SQL-injection guard)", () => {
    expect(() => assertAllowedRagTable("knowledge_entries")).toThrow(/not an allowed RAG table/i);
    expect(() => assertAllowedRagTable("personal_rag; drop table users")).toThrow();
  });

  it("exposes exactly the two allowed tables", () => {
    expect([...ALLOWED_RAG_TABLES].sort()).toEqual(["personal_rag", "turicks_brain"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/db/rag-search.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/db/rag-search.ts`**

```typescript
/**
 * pgvector nearest-neighbour search over the isolated RAG tables.
 * Replaces the old ChromaDB HTTP calls. The table name is validated against a
 * hard allowlist before being interpolated into SQL — this both enforces the
 * ADR-013/015 store boundary and prevents SQL injection via table name.
 */
import { sql } from "drizzle-orm";
import { db } from "./client.js";

export const ALLOWED_RAG_TABLES = new Set(["personal_rag", "turicks_brain"] as const);
export type RagTable = "personal_rag" | "turicks_brain";

export interface RagHit {
  content: string;
  metadata: Record<string, unknown>;
  score: number; // cosine similarity in [0,1], higher = closer
}

/** Throws if `table` is not one of the two allowed RAG tables. */
export function assertAllowedRagTable(table: string): asserts table is RagTable {
  if (!ALLOWED_RAG_TABLES.has(table as RagTable)) {
    throw new Error(`"${table}" is not an allowed RAG table`);
  }
}

/**
 * Return the top-k rows from `table` nearest to `queryEmbedding` by cosine
 * distance. score = 1 - cosine_distance.
 */
export async function searchRagTable(
  table: RagTable,
  queryEmbedding: number[],
  topK: number,
): Promise<RagHit[]> {
  assertAllowedRagTable(table);
  const vec = `[${queryEmbedding.join(",")}]`;
  const limit = Math.min(Math.max(topK, 1), 10);
  // sql.identifier() safely quotes the (already allowlisted) table name.
  const rows = await db.execute(sql`
    SELECT content, metadata, 1 - (embedding <=> ${vec}::vector) AS score
    FROM ${sql.identifier(table)}
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> ${vec}::vector
    LIMIT ${limit}
  `);
  return (rows as unknown as Array<{ content: string; metadata: Record<string, unknown> | null; score: number }>).map(
    (r) => ({ content: r.content, metadata: r.metadata ?? {}, score: Number(r.score) }),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/unit/db/rag-search.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/db/rag-search.ts tests/unit/db/rag-search.test.ts
git commit -m "feat(db): pgvector RAG search layer with table-allowlist isolation guard"
```

---

### Task 5: Rewrite the two RAG tools to use pgvector

**Files:**
- Modify: `src/tools/rag.ts` (replace ChromaDB HTTP path with embed + pgvector)
- Modify: `tests/unit/tools/rag.test.ts` (swap fetch mocks for embed/search mocks)

- [ ] **Step 1: Rewrite the test to the new contract**

Replace the body of `tests/unit/tools/rag.test.ts` with mocks of `embedText` and `searchRagTable`, keeping the SAME tool output contract:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/lib/embed.js", () => ({ embedText: vi.fn() }));
vi.mock("../../../src/db/rag-search.js", () => ({ searchRagTable: vi.fn() }));

const { embedText } = await import("../../../src/lib/embed.js");
const { searchRagTable } = await import("../../../src/db/rag-search.js");
const { searchPersonalRagTool, searchTuricksBrainTool } = await import("../../../src/tools/rag.js");

const mEmbed = embedText as unknown as ReturnType<typeof vi.fn>;
const mSearch = searchRagTable as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => { mEmbed.mockReset(); mSearch.mockReset(); mEmbed.mockResolvedValue([0.1, 0.2]); });

describe("search_personal_rag (pgvector)", () => {
  it("queries the personal_rag table and formats hits", async () => {
    mSearch.mockResolvedValueOnce([{ content: "TS since 2019", metadata: { source_file: "cv.md" }, score: 0.91 }]);
    const r = await searchPersonalRagTool.execute({ query: "typescript" });
    expect(mSearch).toHaveBeenCalledWith("personal_rag", [0.1, 0.2], 5);
    expect(r.success).toBe(true);
    expect(r.data).toContain("cv.md");
    expect(r.data).toContain("TS since 2019");
  });

  it("requires a non-empty query", async () => {
    const r = await searchPersonalRagTool.execute({ query: "  " });
    expect(r.success).toBe(false);
  });

  it("soft-fails when embedding/search throws (Ollama or DB down)", async () => {
    mEmbed.mockRejectedValueOnce(new Error("Ollama embeddings unreachable"));
    const r = await searchPersonalRagTool.execute({ query: "x" });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/unavailable|Ollama/i);
  });
});

describe("search_turicks_brain (pgvector)", () => {
  it("queries the turicks_brain table", async () => {
    mSearch.mockResolvedValueOnce([{ content: "We chose LangGraph", metadata: { source_path: "ADR-002.md" }, score: 0.8 }]);
    const r = await searchTuricksBrainTool.execute({ query: "langgraph" });
    expect(mSearch).toHaveBeenCalledWith("turicks_brain", [0.1, 0.2], 5);
    expect(r.success).toBe(true);
    expect(r.data).toContain("ADR-002.md");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/unit/tools/rag.test.ts`
Expected: FAIL — `rag.ts` still calls `fetch`, not `searchRagTable`.

- [ ] **Step 3: Rewrite `src/tools/rag.ts`**

Replace the file body (keep the same tool `name`, `description`, `input_schema` blocks verbatim from the current file). Replace the config/fetch helpers and both `execute` functions:

```typescript
import { childLogger } from "../infra/logger.js";
import type { UnifiedTool, ToolResult } from "./index.js";
import { embedText } from "../lib/embed.js";
import { searchRagTable, type RagTable, type RagHit } from "../db/rag-search.js";

const log = childLogger({ module: "tool:rag" });

function formatResults(results: RagHit[], query: string, sourceField: string): string {
  if (results.length === 0) {
    return `No results found for "${query}". The knowledge base may not have this information yet.`;
  }
  return results
    .map((r, i) => {
      const src = (r.metadata[sourceField] as string | undefined) ?? "unknown";
      return `${i + 1}. [${src}] (score ${r.score.toFixed(2)})\n${r.content.trim()}`;
    })
    .join("\n\n");
}

async function runRagSearch(
  table: RagTable,
  args: Record<string, unknown>,
  label: string,
  sourceField: string,
): Promise<ToolResult> {
  const query = ((args["query"] as string | undefined) ?? "").trim();
  if (!query) return { success: false, error: "query is required" };
  const topK = Math.min(Math.max(Number(args["top_k"] ?? 5), 1), 10);
  try {
    const embedding = await embedText(query);
    const hits = await searchRagTable(table, embedding, topK);
    log.debug({ table, query, total: hits.length }, "rag search");
    return {
      success: true,
      data: `${label} for "${query}" (${hits.length} results):\n\n${formatResults(hits, query, sourceField)}`,
    };
  } catch (err) {
    log.warn({ table, err: (err as Error).message }, "rag search failed");
    return { success: false, error: `Knowledge search unavailable: ${(err as Error).message}` };
  }
}
```

Then change each tool's `execute` to delegate (keep the existing `name`/`description`/`input_schema`):

```typescript
// inside searchPersonalRagTool:
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    return runRagSearch("personal_rag", args, "Personal knowledge search", "source_file");
  },
// inside searchTuricksBrainTool:
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    return runRagSearch("turicks_brain", args, "Turicks Brain search", "source_path");
  },
```

Delete the now-unused `PERSONAL_RAG_URL`, `TURICKS_BRAIN_URL`, `RagSearchResponse`, and `callRagApi`.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run tests/unit/tools/rag.test.ts && pnpm lint`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/tools/rag.ts tests/unit/tools/rag.test.ts
git commit -m "refactor(rag): query pgvector via local embeddings, drop ChromaDB HTTP path"
```

---

### Task 6: One-time migration — Chroma vectors → pgvector

**Files:**
- Create: `scripts/migrate-chroma-to-pgvector.ts`

> The Chroma stores use the SAME `nomic-embed-text` model, so vectors are
> identical — we copy them directly, no re-embedding. Chroma persists to SQLite
> at `~/Projects/{personal-rag,turicks-brain-rag}/data/chroma_db/chroma.sqlite3`.

- [ ] **Step 1: Implement the export+load script**

```typescript
/**
 * One-time migration: read embeddings + documents from the two ChromaDB SQLite
 * stores and bulk-insert into the pgvector tables. Idempotent: truncates the
 * target table before loading so re-runs are safe.
 *
 * Run: node --env-file=.env --import tsx/esm scripts/migrate-chroma-to-pgvector.ts
 *
 * Reads Chroma via its SQLite file directly (no Python needed). Chroma stores
 * embeddings in the `embeddings` + `embedding_fulltext_search` / metadata tables;
 * the exact table layout varies by Chroma version, so we shell out to a tiny
 * Python exporter if available, else fail loud with instructions.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";

interface ChromaRecord { document: string; embedding: number[]; metadata: Record<string, unknown> }

const SOURCES: Array<{ table: "personal_rag" | "turicks_brain"; chromaDir: string; collection: string }> = [
  { table: "personal_rag", chromaDir: join(homedir(), "Projects/personal-rag/data/chroma_db"), collection: "personal_knowledge" },
  { table: "turicks_brain", chromaDir: join(homedir(), "Projects/turicks-brain-rag/data/chroma_db"), collection: "turicks_brain" },
];

/** Use the source repo's own venv python + chromadb to dump records as JSON. */
function exportFromChroma(chromaDir: string, collection: string): ChromaRecord[] {
  const py = `
import json, sys, chromadb
client = chromadb.PersistentClient(path=sys.argv[1])
col = client.get_collection(sys.argv[2])
got = col.get(include=["documents","embeddings","metadatas"])
out = [{"document": d, "embedding": e, "metadata": m or {}} for d, e, m in zip(got["documents"], got["embeddings"], got["metadatas"])]
print(json.dumps(out))
`;
  const venvPy = join(chromaDir, "../../.venv/bin/python");
  const python = existsSync(venvPy) ? venvPy : "python3";
  const raw = execFileSync(python, ["-c", py, chromaDir, collection], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(raw) as ChromaRecord[];
}

async function load(table: "personal_rag" | "turicks_brain", records: ChromaRecord[]): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE ${sql.identifier(table)}`);
  for (const r of records) {
    if (!r.embedding || r.embedding.length === 0) continue;
    const vec = `[${r.embedding.join(",")}]`;
    await db.execute(sql`
      INSERT INTO ${sql.identifier(table)} (content, metadata, embedding)
      VALUES (${r.document}, ${JSON.stringify(r.metadata)}::jsonb, ${vec}::vector)
    `);
  }
}

async function main(): Promise<void> {
  for (const s of SOURCES) {
    if (!existsSync(s.chromaDir)) { console.warn(`SKIP ${s.table}: ${s.chromaDir} not found`); continue; }
    console.log(`Exporting ${s.collection} from ${s.chromaDir} ...`);
    const records = exportFromChroma(s.chromaDir, s.collection);
    console.log(`  ${records.length} records → loading into ${s.table}`);
    await load(s.table, records);
    const [{ count }] = (await db.execute(sql`SELECT count(*)::int AS count FROM ${sql.identifier(s.table)}`)) as unknown as Array<{ count: number }>;
    console.log(`  ✅ ${s.table} now has ${count} rows`);
  }
  process.exit(0);
}
main().catch((e) => { console.error("Migration FAILED:", e); process.exit(1); });
```

> **Collection names:** confirm the actual Chroma collection name in each repo
> before running — grep `get_or_create_collection` / `create_collection` in
> `~/Projects/personal-rag/src/store.py` and `~/Projects/turicks-brain-rag/src/store.py`
> and update the `collection` fields above to match.

- [ ] **Step 2: Verify collection names match the source repos**

Run: `grep -rn "create_collection\|get_collection\|name=" ~/Projects/personal-rag/src/store.py ~/Projects/turicks-brain-rag/src/store.py`
Expected: shows the collection name strings. Edit `SOURCES[].collection` to match.

- [ ] **Step 3: Dry-run the migration against local Postgres**

Run: `node --env-file=.env --import tsx/esm scripts/migrate-chroma-to-pgvector.ts`
Expected: prints per-table row counts, exits 0. Spot-check: `docker exec founderos-postgres psql -U founderos -c "SELECT count(*) FROM personal_rag;"`

- [ ] **Step 4: Parity check**

Run a query through the rewritten tool and confirm sane results:
`node --env-file=.env --import tsx/esm -e "import('./src/tools/rag.js').then(async m => console.log((await m.searchTuricksBrainTool.execute({query:'why did we choose LangGraph'})).data))"`
Expected: returns relevant content with scores ~0.7–0.95, comparable to the old Chroma top-k.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-chroma-to-pgvector.ts
git commit -m "feat(migration): copy ChromaDB vectors into pgvector tables (no re-embed)"
```

---

### Task 7: Production compose stack — pgvector Postgres + loopback Ollama

**Files:**
- Create: `deploy/stack.compose.yml` (supersedes `deploy/postgres.compose.yml`)
- Delete: `deploy/postgres.compose.yml`
- Modify: `deploy/deploy.sh` (bring up the stack + pull the embed model)

- [ ] **Step 1: Write `deploy/stack.compose.yml`**

```yaml
# FounderOS — production data stack. App runs NATIVE under systemd (needs the
# claude CLI); only stateful services live here. Both ports bind to 127.0.0.1
# only — never the public internet (privacy requirement).
services:
  postgres:
    image: pgvector/pgvector:pg16
    container_name: founderos-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: founderos
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-founderos}
      POSTGRES_DB: founderos
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - founderos_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U founderos"]
      interval: 10s
      timeout: 5s
      retries: 5

  ollama:
    image: ollama/ollama:latest
    container_name: founderos-ollama
    restart: unless-stopped
    # Loopback only — the native app reaches it at http://localhost:11434.
    ports:
      - "127.0.0.1:11434:11434"
    volumes:
      - founderos_ollama:/root/.ollama

volumes:
  founderos_pgdata:
  founderos_ollama:
```

- [ ] **Step 2: Update `deploy/deploy.sh`**

Replace the Postgres-only block. Change the compose file reference and add a model-pull + Ollama readiness step before migrations:

```bash
echo "==> Bringing up data stack (postgres + ollama)"
docker compose -f deploy/stack.compose.yml up -d

# Wait for Postgres
for i in {1..30}; do
  if docker exec founderos-postgres pg_isready -U founderos >/dev/null 2>&1; then break; fi
  echo "    waiting for postgres ($i/30)"; sleep 1
done

# Ensure the embedding model is present (idempotent — no-op if already pulled)
echo "==> Ensuring embedding model is pulled"
docker exec founderos-ollama ollama pull nomic-embed-text
```

(Keep the existing `pnpm db:migrate`, `systemctl restart founderos`, and `/health` steps that follow.)

- [ ] **Step 3: Remove the superseded compose file**

```bash
git rm deploy/postgres.compose.yml
```

- [ ] **Step 4: Validate compose syntax locally**

Run: `docker compose -f deploy/stack.compose.yml config -q`
Expected: no output (valid). Then bring it up locally: `docker compose -f deploy/stack.compose.yml up -d && docker exec founderos-ollama ollama pull nomic-embed-text`
Expected: both containers healthy; model pulls.

- [ ] **Step 5: Commit**

```bash
git add deploy/stack.compose.yml deploy/deploy.sh
git commit -m "feat(deploy): pgvector Postgres + loopback Ollama compose stack; drop Chroma services"
```

---

### Task 8: Executor auth + env example + runbook updates

**Files:**
- Modify: `.env.example` (add embedding + executor vars)
- Modify: `docs/guides/DEPLOYMENT.md` (replace RAG/Chroma section + dual-auth + box size)

- [ ] **Step 1: Add the new vars to `.env.example`**

Append a section:

```bash
# ── Embeddings (local Ollama — RAG queries, never leaves the box) ─────────────
OLLAMA_URL=http://localhost:11434
EMBED_MODEL=nomic-embed-text
EMBED_DIM=768

# ── Claude Code executor auth ─────────────────────────────────────────────────
# Default: OAuth — run `claude login` once on the box; the CLI uses stored creds.
# Fallback: uncomment the next line to switch to API-key billing instantly
# (buildExecutorEnv prefers the API key when set). Restart the service after.
# CLAUDE_EXECUTOR_API_KEY=sk-ant-...
# CLAUDE_EXECUTOR_BASE_URL=
```

- [ ] **Step 2: Update `docs/guides/DEPLOYMENT.md`**

Make these edits:
1. Change the box recommendation from CX22 to **CX32 (8 GB, ~€7.5/mo)** with the RAM rationale (Node + claude subprocess + Postgres + Ollama).
2. Replace any `deploy/postgres.compose.yml` reference with `deploy/stack.compose.yml`.
3. Add a **"Knowledge stores"** subsection stating there is now ONE Postgres with `knowledge_entries` + `personal_rag` + `turicks_brain`; no Chroma, no Python RAG services; Ollama embeds locally.
4. Add a **"Claude executor auth"** subsection: install CLI, `claude login` once (paste-URL OAuth works headless), verify `claude -p "say hi"` as `founderos`; to switch to API key, uncomment `CLAUDE_EXECUTOR_API_KEY` in `.env` and `systemctl restart founderos`.
5. Add a **migration** step to the first-deploy sequence: after `pnpm db:migrate`, run `node --env-file=.env --import tsx/esm scripts/migrate-chroma-to-pgvector.ts` once (or `pnpm brain:sync` + re-ingest if Chroma export is unavailable).
6. Privacy note: confirm `ufw` allows SSH only; both 5432 and 11434 bind to `127.0.0.1`.

- [ ] **Step 3: Verify docs reference no dead paths**

Run: `grep -rn "postgres.compose\|ChromaDB\|8765\|8766\|uvicorn" docs/guides/DEPLOYMENT.md`
Expected: no stale references to the removed Chroma services remain (port 8765/8766/uvicorn should be gone).

- [ ] **Step 4: Commit**

```bash
git add .env.example docs/guides/DEPLOYMENT.md
git commit -m "docs(deploy): pgvector + local-embed runbook, dual executor auth, CX32 sizing"
```

---

### Task 9: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit + lint gate**

Run: `pnpm gate`
Expected: `pnpm lint` clean (tsc), all tests green (no regressions from the rag.ts rewrite).

- [ ] **Step 2: Live integration — embed + search end-to-end**

With the stack up + migration loaded, run:
`node --env-file=.env --import tsx/esm -e "import('./src/tools/rag.js').then(async m => { console.log(await m.searchPersonalRagTool.execute({query:'my TypeScript experience'})); console.log(await m.searchTuricksBrainTool.execute({query:'Naggar pricing'})); })"`
Expected: both return `success: true` with relevant content + scores. No HTTP-to-8765/8766 calls in logs.

- [ ] **Step 3: Isolation proof**

Run: `pnpm vitest run tests/unit/db/rag-search.test.ts`
Expected: guard rejects `knowledge_entries` and injection strings — cross-store ban enforced.

- [ ] **Step 4: Live Telegram path (REAL gateway — per CLAUDE.md rule #19)**

Restart the bot, then via Telegram (or `scripts/probe-real-task.ts`) ask: "what did we decide about LangGraph?" and "what are my TypeScript skills?".
Expected: routes to `personal` dept, calls `search_turicks_brain` / `search_personal_rag`, returns real content. Confirm 0× 409 in `/tmp/founderos.log`.

- [ ] **Step 5: Final commit / PR prep**

```bash
git log --oneline origin/main..HEAD   # review the task commits
gh pr create --title "feat: consolidate RAG into pgvector + executor dual-auth" --body "Implements docs/superpowers/specs/2026-06-13-production-rag-and-executor-design.md"
```

---

## Notes for the implementer
- **`.js` import extensions** are mandatory even for `.ts` files (NodeNext ESM).
- **`process.env["KEY"]`** bracket notation, never dot.
- Do not touch `office.ts`, prompts, or the graph — tool contracts are unchanged by design.
- If `pnpm db:generate` cannot emit the `vector` type (older drizzle-kit), hand-write the column DDL in the migration; the schema.ts `vector()` is only needed for TS typing of queries we run via raw `sql`.
- The `db.execute(sql\`...\`)` return shape from postgres.js is an array of row objects — cast as shown.
