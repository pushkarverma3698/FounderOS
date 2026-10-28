# AG-067: brain sync writes only the store search reads

Plan: `docs/plans/2026-10-27-simplify-agent-workflow.md` task 8. Founder request 2026-10-27: remove over-engineering
from the brain so it works without follow-up fixes.

Depth: **Lite**. It changes no schema and leaves existing rows alone. It stops writes to a table nothing reads and
deletes dead functions. Dropping tables is a separate Full-depth step and is **not** part of this brief.
Base: fresh `origin/main`, branch `chore/brain-sync-slim`, draft PR to `beta`. PR body needs `Moves: A`.

## Why

`pnpm brain:sync` writes two stores. `brain.brain_memories` is the one `search_memory` reads (`src/mcp/brain-tools.ts:117`).
`brain.knowledge_entries` is read by nothing: its query functions have 0 callers. Every sync still upserts one row per
doc there and calls Ollama once per changed doc to embed it (10-27 log: "14 doc embeddings written to knowledge_entries").
Separately, brain-sync went red 3 times on 10-27 at recall@3 = 9/10, because `governance/brain-recall-golden.json`
pins `baseline` at 10 with 10 cases, so any one miss fails the run.

## Measured 2026-10-27 (re-check in step 1; if a number differs, stop and report it)

| Fact | Value | How |
|---|---|---|
| Rows | `brain_memories` 2,679 (ACTIVE 919 / ARCHIVED 1,504 / SUPERSEDED 256); `knowledge_entries` 1,470 (249 current); `turicks_brain` 1,352; `research_cache` 2,429 | `ssh founderos-vps "docker exec founderos-postgres psql -U founderos -d founderos -tAc '<SELECT count(*)…>'"` |
| Callers of `searchKnowledgeEntries`, `getKnowledgeByType`, `getKnowledgeEntryCount`, `getTuricksBrainCount` | 0 (only their definitions and comments in `src/db/queries.ts:1036-1156`) | `grep -rn <name> src scripts tests` |
| Writers of `knowledge_entries` | only `upsertEntry` in `scripts/sync-turicks-brain.ts` (the import at line 41, block at lines 502-619, calls in `main()`) | grep `knowledgeEntries` |
| Users of `--keyword-only` | none outside `scripts/sync-turicks-brain.ts` (lines 700, 712, 724-727, 740, 760, 766, 775, 788-789). It writes only `knowledge_entries`, so with that gone the mode does nothing. | grep |
| Tests importing the sync script | `tests/unit/scripts/sync-brain-chunk-plan.test.ts` (imports `chunkPlan` only). No test touches `needsEntryEmbedding`, `entryEmbeddingText`, `tryEmbedEntry`, `upsertEntry`. | grep |
| Anything parsing the sync's output | nothing: `brain-sync.yml` runs `pnpm brain:sync`, then counts `brain_memories`, then runs the recall check | `.github/workflows/brain-sync.yml:55-82` |
| Recall golden set | 10 cases, `baseline: 10`. Tests use their own `baseline: 1` fixtures, not this file. | `jq` on the file; `tests/unit/scripts/brain-recall-check.test.ts:63` |

## Build

1. **Re-measure.** Run the row counts above, and on the VPS
   `grep -rln "knowledge_entries\|turicks_brain\|research_cache" /usr/local/bin /home/*/bin /etc/cron* 2>/dev/null`
   (read-only). Paste both outputs into the PR. A hit outside this repo means stop and report; do not build.
2. **`scripts/sync-turicks-brain.ts`:**
   - Delete the doc-level embedding block and `upsertEntry` (lines 502-619), the `knowledgeEntries` import (line 41),
     and the `--keyword-only` mode.
   - In `main()` the per-doc loop calls only `syncVectorChunks`. Each doc logs one line: `✅ <type>: <title> (N chunks embedded)`
     or `— <type>: <title> (N chunks already current)`. The summary line keeps the chunk counts and failures and drops the
     inserted/updated/skipped and doc-embedding counts.
   - Rewrite the header comment (lines 1-29) for one store, and drop the keyword-only hint from the Ollama error.
   - Leave untouched: `chunkPlan`, `declaredDocStatus`, `syncVectorChunks`, the Ollama probe, the project tagging.
3. **`src/db/queries.ts`:** delete the four functions above and the two section comments that describe them (lines 1036-1156).
   Remove `knowledgeEntries` from the import list if nothing else uses it. Keep the schema in `src/db/schema.ts` until the
   tables are dropped.
4. **`governance/brain-recall-golden.json`:** `baseline` 10 → 8. Add `"baseline_note"` only if `parseCases` accepts extra
   keys (it reads `baseline` and `cases` only; check before adding). Cases stay as they are.

## Tests first

- Add to `tests/unit/scripts/sync-brain-chunk-plan.test.ts`: the module exports no `upsertEntry`, `tryEmbedEntry`,
  `needsEntryEmbedding` or `entryEmbeddingText` (fails before step 2, passes after).
- `pnpm gate > /tmp/ag067-gate-$$.log 2>&1; echo "exit=$?"`, which must exit 0. Show the test count line.

## Live proof

1. Before merge, pick 5 `search_memory` queries with project `founderos` (e.g. "promotion merge commit", "worktree
   fence", "brain sync", "Recruitee hCaptcha", "VPS RAM reaper") and record each top-1 `source`.
2. After the merge to `main` and deploy: `gh workflow run brain-sync.yml`, then `gh run watch <id> --exit-status`.
   Show the log's summary line (no `knowledge_entries` in it) and `recall@3`.
3. The same 5 queries return the same top-1 sources. Count `knowledge_entries` again: still 1,470, so nothing new was written.

## Not in this brief

Dropping `knowledge_entries`, `turicks_brain` and `research_cache` (5,251 rows, none read), the migration, and narrowing
`ALLOWED_RAG_TABLES` (`src/db/rag-search.ts:19`) all wait a week after this merges, then go through a `pg_dump` and a
Full-depth PR by Claude.

## Before-you-dispatch check (`docs/antigravity/README.md`)

1. Target exists? Yes. The functions, lines and block were grepped on 10-27 (table above).
2. Literals measured? Row counts by read-only `psql` on 10-27. Line numbers from `sed -n` on `origin/main` 3c67cc34.
   The red runs come from `gh run view --log-failed` on 40500305021, 40498595685 and 40492883533.
3. Claims about unopened files? The VPS cron and bin grep in step 1 covers the only readers not in this repo. The
   brief asks for it instead of asserting the result.
4. Granularity? Per function and per block, with the log line format given, so the summary still shows chunk work.
