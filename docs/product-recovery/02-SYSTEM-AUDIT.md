# System Audit — measured inventory

All numbers measured 2026-08-08 against working tree `pr-423-local` (= `origin/main` content)
and prod VPS `f7ea923`.

---

## 1. Code surface

| Directory | Files | LOC | Importers outside itself | Verdict |
|---|---:|---:|---|---|
| `src/tools/` | 103 | 19,181 | many | **live** — 54% of all source |
| `src/infra/` | 47 | 7,233 | many | live |
| `src/agents/` | 38 | 5,289 | many | live |
| `src/db/` | 17 | 4,747 | many | live |
| `src/gateway/` | 19 | 2,918 | entrypoint | live |
| `src/kernel/` | 19 | 2,562 | gateway | live |
| `src/core/` | 6 | 960 | many | live |
| `src/eval/` | 6 | 859 | scripts | live (milestone) |
| `src/evolution/` | 9 | 896 | `infra/scheduler.ts` only | live, thin |
| `src/mcp/` | 7 | 880 | `capabilities`, `external-mcp` | live (flag-gated) |
| `src/outreach/` | 10 | **648** | **none** | **ORPHAN** |
| `src/lib/` | 3 | 380 | 3 | live |
| `src/workflows/` | 3 | **372** | **none** | **ORPHAN** |
| `src/bench/` | 1 | **198** | **none** | **ORPHAN** |
| `src/proof/` | 1 | 122 | 3 `scripts/proof-*.ts` | **live** (verified — `pnpm proof:*`) |
| `src/types/` | 1 | 24 | — | live |

**Total `src/`: ~47,300 LOC. Orphaned: ~1,218 LOC (2.6%).**

`src/tools/jobhunt/` alone is **54 files** — the largest single subsystem in the repo, and the
one producing 2 outcomes in its lifetime.

## 2. Dead code inside live files

| Symbol | Location | Size | Callers |
|---|---|---|---|
| `composeTurnContext` / `rankMemoryItems` / `calculateMultiSignalScore` | `src/kernel/context-composer.ts` | 88 LOC | **tests only** |
| `SUPERVISOR_PROMPT` / `buildSupervisorPrompt` | `src/agents/prompts/supervisor.ts` | **13,459 chars** | itself + a barrel re-export |
| `writeTaskOutcome` | `src/db/queries.ts:528` | — | **test mocks only** |
| `agents.agent_results` table | prod DB | — | **0 rows** |

The ContextComposer is a complete, tested, five-layer memory-hierarchy engine that **nothing
calls**. It is the fourth confirmed instance of the repo's dominant failure mode: *build a layer,
test it, never wire it.*

## 3. Model-facing surface (per turn)

| Surface | Size | Notes |
|---|---:|---|
| Planner system prompt | ~4,300 chars + catalog | 12 behavioural rules |
| Worker catalog in planner prompt | **79 tool slots / 65 unique** | every tool name, every turn |
| Largest worker prompt (`marketing`) | 13,138 chars (~3.3k tok) | 18 tools |
| `engineering` prompt | 7,223 chars | 9 tools |
| `jobhunt` prompt | 6,319 chars | 9 tools |
| Replayed history | ≤600 chars input + ≤1,500 reply per turn | bounded — good |

Tools per worker: admin 14 · research 12 · comms 5 · engineering 9 · marketing 18 · sales 4 ·
personal 8 · jobhunt 9.

## 4. Instruction layers (repository root)

| File | Lines |
|---|---:|
| `CLAUDE.md` | 294 |
| `README.md` | 240 |
| `ARCHITECTURE_LEDGER.md` | 212 |
| `JARVIS-ARCHITECTURE.md` | 212 |
| `AGENTS.md` | 195 |
| `agent-rules.md` | 123 |
| `GEMINI.md` | 66 |
| **Root total** | **1,342** |
| `docs/**/*.md` | **22,403** across 173 files |

## 5. Enforcement layers

`scripts/verify-architecture.ts` + `governance/architecture-baseline.json`:

```json
{ "gateway-imports": 0, "kernel-purity": 0, "fail-open-catch": 11, "loc-budget": 5, "regex-routing": 0 }
```

Five ratchets, three at zero. **This layer has held.** It is the only instruction layer in the
repo that has not drifted, and it is where new rules belong.

## 6. Test & eval surface

| Surface | Count | What it measures |
|---|---:|---|
| Unit/integration test files | 272 | code correctness, deterministic, $0 |
| Golden eval tasks | ~46 | **routing + tool choice + HITL flag** |
| `pnpm qa:telegram` | 22 tasks | live MTProto founder simulation |

Latest `eval-report.md` (2026-08-06): routing 71% · tool selection 42% · HITL 77% ·
**overall 29%**, with 27 of 41 tasks excluded as infra errors.

**Nothing in any suite asserts that a founder objective produced a real artifact.**

## 7. Production runtime state (2026-08-08)

| Fact | Value |
|---|---|
| Prod commit | `f7ea923` = `origin/main` — **not stale** |
| Service | `active`, restarted 07:01:32 UTC |
| Free sweep | every 30 min, 285 boards, ~20,550 seen, **0 screened** — ≥3 days |
| Metered sweep | every 3rd day, `30 1 */3 * *` |
| `job_applications` | 39 rows · 2 applied · 6 `do_today` |
| `hitl_approvals` | 178 |
| `action_log` | 73 |
| `episodic_memory` | 44 |
| `failure_lessons` | 2 |
| `agent_results` | **0** |
| `/opt/founderos/artifacts` | **does not exist** |
