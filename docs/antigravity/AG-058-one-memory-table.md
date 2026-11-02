# AG-058 — One memory table; drop the empty tables

**Source:** [docs/plans/2026-10-08-simplify-founderos.md](../plans/2026-10-08-simplify-founderos.md) task AG-058.
Absorbs AG-028 (Telegram and daemons write to the brain).
**Depends on:** AG-054 (the loop is the only reader). It uses AG-052's table inventory.
**Branch:** `task/issue-<N>-one-memory-table`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Full: schema, migrations, existing prod data.
**Moves:** A.

Read [STANDARDS.md](STANDARDS.md) and `~/.claude/skills/production-ready/SKILL.md` before writing code.

## Goal

A fact saved by any agent (the bot, Claude on the Mac, Antigravity, a daemon) is found by every other agent with one
search, in one table.

## Problem (measured on prod 2026-10-08)

- 7 memory or knowledge stores. Rows:
  - `brain_memories` 2,279.
  - `turicks_brain` 1,352.
  - `knowledge_entries` 835.
  - `episodic_memory` 158.
  - `failure_lessons` 24.
  - `personal_rag` 4.
  - `founder_context` 1.
- The comment at `src/agents/capabilities.ts:101-107` shows which departments read which store. AG-025 already had to
  join admin's search to the right one.
- `src/db/schema.ts:417-418` keeps `personal_rag` and `turicks_brain` apart on purpose (ADR-013/015 isolation).
- 43 tables against the 20 in CLAUDE.md. 7 are empty, and 1 is a leftover backup.

## Expected behavior

1. **Map first.** For each of the 7 stores: its writer, its readers (grep), its row shape, and whether the loop reads
   it. Paste the map in the PR. A store with a documented isolation reason (personal_rag, turicks_brain) stays apart.
2. **One table:** `brain_memories` becomes the store for agent memory: decisions, bugs, lessons, episodes, knowledge
   entries.
   - A migration copies `knowledge_entries`, `episodic_memory` and `failure_lessons` into it, with a `kind` column and
     the source id kept.
   - Then every reader and writer moves to it. Embeddings use the existing `nomic-embed-text` path.
3. **One search** (`search_memory`) for the bot, the hub and the daemons. The Telegram turn summary and the daemons'
   results are written there too (AG-028's goal).
4. **Drop**, in a second migration and a second deploy:
   - The source tables, once nothing reads them for 2 days.
   - The 7 empty tables and the backup table from AG-052's list, each grepped first for readers.
5. **CLAUDE.md** table count corrected (layer-4 doc, one line).

## Files in scope

`src/db/schema.ts`, `drizzle/` migrations, `src/db/queries/`, `src/mcp/brain-tools.ts`, the memory tools in
`src/agents/agent-tools/`, writers in `deploy/vps-daemons/` if any, tests.

## Constraints

- `deploy/backup-db.sh` runs before each migration deploy. Paste the backup file name.
- The copy is idempotent (keyed by source table + source id). Running it twice adds nothing.
- Row counts are checked before and after, and pasted.
- No personal data moves into a table that the hub's `brain` scope serves.

## Explicitly forbidden

- Merging `personal_rag` or `turicks_brain` into anything.
- Dropping a table in the same deploy as the copy.

## Verification commands

```bash
pnpm gate
pnpm vitest run tests/unit/db tests/unit/mcp
ssh founderos-vps 'sudo -n docker exec founderos-postgres psql -U founderos -d founderos -c "select kind, count(*) from brain.brain_memories group by 1"'
```

## Acceptance criteria

- A failing test first: a fact saved through the hub's `save_decision` is returned by the bot's `search_memory`.
- After deploy: save one decision from the Mac (`turicks-brain` `save_decision`), then ask the bot in Telegram about
  it. Paste the reply.
- Row totals before and after match, minus counted duplicates.
