# 2026-10-04 — conversation memory, `/review`, self-knowledge, recency

Five draft PRs against the plan `docs/plans/2026-10-04-nl-control-and-knowledge-audit.md` (all labelled `unfreeze`):

- #862: every finished turn goes to `conversation_turns`; "what did I say yesterday?" answers from it in the founder's own words.
- #863: `/review` reads the daemons' own `~/.claude/<daemon>.effective` files instead of calling `crontab`, which the bot's
  `NoNewPrivileges=true` unit cannot run.
- #865 (stacked on #863): "what can you do / what's running" is built from the capability registry, not from the model's memory.
- #867: search favours recent documents and skips plans a doc has marked superseded (knowledge-audit row d).
- #869 (stacked on #862): `search_memory` type `conversations` reads the turn log instead of the dead `conversations` table (row e).

## What was learned
- `brain_memories.status` has existed since migration 0037 and nothing read or set it. Every plan was `ACTIVE` forever.
- `brain:sync` deletes and re-inserts a source's chunks, so `created_at` is the sync time. Recency comes from the date in the
  file name; a status set only in the database would be wiped on the next sync, so a doc declares it in its own first 20 lines.
- Recency is a tie-breaker: weight 1 today, falling to 0.7 at 90 days, applied before the cut to `topK`. Undated docs (ADRs,
  rules) are never aged. A weight of 0 would let a stale doc vanish with no error.
- The `conversations` table had a reader and no writer. A tool that reads a table nothing writes looks fine in unit tests and
  returns nothing in prod.
- Conversation search is thread-scoped from `config.configurable.thread_id`, never an argument: a guest in an allow-listed
  group chat can call every non-HITL tool.

- Real Postgres found a bug the mocked tests could not: with no topic words `findConversationTurns` sorted by the constant 0,
  which Postgres reads as a column position ("ORDER BY position 0 is not in select list"), so every time-window-only recall
  ("what did I ask yesterday?") would have failed in prod. Fixed in #862 with a SQL-shape unit test. `tests/integration` is not
  in `pnpm test`, so CI never runs the real-database suites: those were run once in a scratch workflow (15 of 15 pass after the fix).
- Golden retrieval eval on the prod `brain_memories` copy, before and after #867: recall@5 89.2% both; hybrid MRR 0.811 to 0.820;
  hybrid+rerank MRR 0.804 to 0.813. No regression. 1007 of 2181 prod chunks carry a date in the file name, so the weighting has data to act on.
- The IDE MCP server calls `searchMemoryTool.invoke({query, type})` with no thread id: `conversations` refuses and `all` skips the turn log.

## Open (not fixed)
- The LLM reranker (`RAG_RERANK=1`, off) can still override recency; the eval above shows no regression with it on.
- `upsertConversation` and the `conversations` table are orphaned. Dropping the table is the founder's call.
- Row f: `knowledge_entries` has no embeddings. Row g: `personal_rag` is a stub; ask the founder what it should hold.
- No plan is marked superseded yet. That is the founder's call; the mechanism is in `.claude/rules/docs-and-brain.md`.
- `tests/integration` real-database suites are outside CI. A job that runs them against a pgvector service container would have caught the ORDER BY bug before review.
