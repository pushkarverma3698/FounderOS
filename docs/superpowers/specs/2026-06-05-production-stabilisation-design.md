# FounderOS — Production Stabilisation & Wiring Rules — Design

_Date: 2026-06-05 · Status: Approved — implementing_

## Goal

Make FounderOS production-ready for daily use starting today. Two halves:
1. **Wiring rules** — document the exact file-touch sequence for every common task, so nothing is ever left half-wired (the "added in one file, forgot the second → runtime error" class).
2. **P1 stabilisation** — fix the open correctness + structure gaps, then verify end-to-end.

## Why this exists

Tracing the real code revealed the blast radius is wider than documented:
- Adding a **tool** touches 6 layers (existing playbook says 5 — misses `src/mcp/server.ts`).
- Adding a **department** touches 10 files (the 8→7 change proved this).
- Adding a **workflow** or **command** has no documented map at all.

A missed file is a silent failure: e.g. forgetting `eval/office-invoker.ts`'s
DEPARTMENTS set makes the eval route to `null` and every golden task for that
dept fails without an obvious cause.

## Part A — Docs reorganised by role

```
docs/
├── README.md                         NEW — master index linking every doc
├── guides/                           how it works + how to run
│   ├── ARCHITECTURE.md               (from docs/architecture.md)
│   ├── OPERATIONS.md                 (from docs/OPERATIONS.md)
│   └── LOCAL-DEV.md                  (from docs/local-dev.md)
├── rules/                            the laws of the codebase
│   ├── PROGRAMMING-RULES.md          NEW — wiring maps for all 4 tasks
│   ├── TOOL-STANDARDS.md             (from docs/TOOL-STANDARDS.md)
│   ├── TESTING-RULES.md              (from docs/TESTING-RULES.md)
│   └── TOOL-INTEGRATION-PLAYBOOK.md  (from docs/PLAYBOOK-TOOL-INTEGRATION.md)
├── decisions/                        ADRs (unchanged)
├── study/                            learning docs (unchanged)
└── phases/                           phase docs (unchanged)
```

Archived (moved to `docs/study/archive/` or deleted if pure duplicate):
`PROGRESS.md`, `STATUS-2026-06-04.md`, `PRODUCTION-READINESS.md`, empty `docs/architecture/` folder.

CLAUDE.md + MEMORY.md references to moved docs are updated.

## Part B — PROGRAMMING-RULES.md

A single doc with four wiring maps. Each map = a numbered file-touch sequence +
a "if you forget this file → you get this error" table. The four maps:

1. **Add a tool** (6 layers): `src/tools/{name}.ts` → test → `agent-tools.ts` wrapper
   → `office.ts` department → `system-prompts.ts` (dept prompt + supervisor routing)
   → `src/mcp/server.ts` (only if read-only + worth exposing).
2. **Add a department** (10 files): `office.ts` (agent + agents list + log) →
   `system-prompts.ts` (prompt + routing table + tool-ownership) → `eval/types.ts`
   (Department type) → `eval/office-invoker.ts` (DEPARTMENTS set) → `eval/golden-tasks.ts`
   → `gateway/commands.ts` (/q list + /departments) → `index.ts` (banner).
3. **Add a workflow** (3 files): `workflows/registry.ts` → test → MEMORY.
4. **Add a command** (4 points): `gateway/commands.ts` handler → `telegram.ts` import +
   `bot.command()` registration → `commands.ts` help text in handleCommands.

Plus the global iron rules (TDD, HITL, idempotency, soft-failure, determinism)
cross-linked to TESTING-RULES.md and TOOL-STANDARDS.md.

## Part C — P1 stabilisation

1. **Calendar idempotency** (TDD): add `idempotency_key` param to `calendarTool`,
   `hasBeenAudited` before create, `writeAuditEntry` only after confirmed event id.
   Wrapper in `agent-tools.ts` passes a deterministic `idemKey("gcal", title, date)`.
2. **Split `agent-tools.ts`** (656 lines) into `src/agents/agent-tools/`:
   - `hitl.ts` — `hitlGate`, `ApprovalRequest`, `idemKey` (shared core)
   - `research.ts`, `comms.ts`, `engineering.ts`, `personal.ts`, `jobhunt.ts`, `memory.ts`
   - `index.ts` — barrel re-export so `office.ts` imports are unchanged.
   Behaviour identical; pure structural move. All tests stay green.
3. **End-to-end verify**: boot single instance, route a probe through all 7 depts,
   confirm HITL fires, live calendar + email send via probe scripts. Document in EVAL.

## Testing

- Calendar idempotency: TDD — RED test (duplicate call → second is skipped) before code.
- agent-tools split: existing suite is the regression guard; no behaviour change allowed.
- Full suite + tsc must stay green after every step.
- Live verify on a clean thread (`/reset`) per the integration playbook rule.

## Success criteria

- [ ] docs/ reorganised; docs/README.md indexes everything; no broken internal links
- [ ] PROGRAMMING-RULES.md has all 4 wiring maps with failure tables
- [ ] Calendar has idempotency guard + passing TDD test
- [ ] agent-tools.ts split into focused modules; office.ts imports unchanged; suite green
- [ ] Full suite + tsc green; bot boots single-instance; live send verified
- [ ] CLAUDE.md "Adding a Tool/Agent" points to the new rules doc

## Out of scope (deferred)

- Merging or rewriting ADRs (only moving folders, not content)
- Multi-tenancy / SaaS concerns
- New features — this is stabilisation only
