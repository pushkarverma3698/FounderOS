# ADR-031 — P4/P5/P6: Signal transactions, schema split, hierarchy tracing

- **Date:** 2026-06-17
- **Status:** Accepted (beta)
- **Follows:** ADR-024 (dept_signals), ADR-029 (P2), ADR-030 (P3)

## P4 — Transactional signal publish + audit

`publishDeptEventWithAudit()` wraps `dept_signals` INSERT + `action_log` INSERT in a
single Postgres transaction. `publish_signal` tool uses it with idempotency key
`signal_published:{event}:{hash}:{thread}`.

**Gate:** `tests/integration/signal-transaction.test.ts` proves duplicate audit key
rolls back the signal row.

## P5 — Separate schemas (`agents` vs `brain`)

Migration `0006_separate_schemas.sql` moves:
- **agents:** operational tables + LangGraph checkpoints
- **brain:** knowledge_entries, personal_rag, turicks_brain

Drizzle `schema.ts` uses `agentsSchema` / `brainSchema`. Checkpointer uses
`schema: "agents"`. Connection `search_path=agents,brain,public`.

**Gate:** `pnpm verify:p456` asserts schemas + table counts on real Postgres.

## P6 — 3-level hierarchy tracing

New seams: `hierarchy.enter`, `hierarchy.exit`. `TraceCallback` emits depth
0 (supervisor) → 1 (engineering) → 2 (coder/qa/devops). `hierarchyDepth()` pure map.

**Gate:** `tests/unit/infra/hierarchy-trace.test.ts` + live trace depths `[0,1,2]`.

## Live verification

```bash
pnpm gate:p456:live
```

Evidence (2026-06-17):
- P4: signalId + matching audit row
- P5: agents_tables=14, brain_tables=3
- P6: turnId grep shows hierarchy.enter depths [0,1,2]
