# ADR-033: Why Hallucination Bugs Recur — Full Audit (2026-06-17)

**Status:** Accepted  
**Date:** 2026-06-17  
**Context:** Production Telegram repeatedly shows ICP/strategy fabrication after empty KB,
stale reply regurgitation on repeat asks, and fixes that pass CI but fail live.

---

## Executive summary

These bugs are **not random regressions** — they are **structural failure modes** in a
multi-agent system with checkpointed state, context isolation, and multiple knowledge stores.
Fixes that only change prompts or add one-off guards **will recur** until the verification
gap and data-pollution paths are closed.

---

## The five root causes (why fixes don't stick)

### 1. Tests prove the wrong path (verification gap — rule #19)

| What CI tests | What production runs |
|---------------|---------------------|
| `office.invoke({ messages: [HumanMessage] })` | `runOfficeSession` → `buildOfficeInput` → guard → trim → Telegram |
| Fresh thread per test | Same `thread_id` for months — checkpoint accumulates |
| Mocked or keyless tools | Real Postgres + Ollama + Composio |
| No `guard.blocked` / `guard.purged` seams | Gateway blocks fabrication **after** invoke |

**Evidence:** 2026-06-15 RAG outage — 1098 tests green, prod returned nothing.  
**2026-06-17 ICP fabrication** — stress harness initially bypassed gateway; fabrication
reached user until guard wired to `office-run.ts`.

**Required:** Every hallucination class needs a **gateway seam test** (fake office + trace
oracle) and a **live stress task** on the real path.

### 2. Checkpoint anchoring (stale reply class)

LangGraph Postgres checkpointer **persists all AI messages forever** (until trim).
When turn 1 fabricates ICP, turn 2+ can answer **without tools** by replaying checkpoint text.

Prod log signature (turnId `731c4521`, `c63cc964`):
- `textLen: 19` ("What is our ICP?")
- **Zero** `tool.call` seams
- ~50 `outputTokens` — instant regurgitation

**Fix (PR #141):** Pre-invoke `purgeStaleFabricatedKnowledgeFromCheckpoint` +
post-block `purgeFabricatedAiFromCheckpoint`.

### 3. Context isolation hides grounding (supervisor blind spot)

Departments use `outputMode: "last_message"`. Supervisor never sees
`search_knowledge` empty tool results — only the dept's synthesized prose.
Model can say "no entries" in dept then supervisor relays fabricated summary.

**Fix:** Gateway execution guard judges **final reply text** deterministically, not tool trail visibility.

### 4. ICP is duplicated across the repo (re-pollution)

Even with prompts cleaned, ICP bands appear in **authoritative-looking sources**:

| Location | Risk |
|----------|------|
| `scripts/seed-founder-context.ts` → `turicks_icp` | `read_context` injects every admin turn |
| `docs/BRAND.md`, `FOUNDER-PROFILE.md`, `ROADMAP.md` | `pnpm brain:sync` → `knowledge_entries` |
| `src/outbound/batch.ts` | Outbound copy embeds ICP |
| `.claude/brand/TURICKS.md` | Synced to brain |

Empty `knowledge_entries` + populated `search_memory` (keyword) = model cites **memory**
with stale strategy docs while `search_knowledge` returns empty — looks contradictory.

**Required:** Single source of truth for ICP in `docs/strategy/01-POSITIONING-AND-NICHE.md`;
seed script reads from there; `brain:sync` must run after deploy; state-checks fail on 0 rows.

### 5. Beta fixes never reach production (deploy gap)

Branch model: `feat → beta → stable → main → CD deploy`.

| Branch | Deploys to VPS? |
|--------|-----------------|
| `beta` | **No** |
| `stable` | **No** |
| `main` | **Yes** (GitHub Actions SSH) |

Hallucination guards merged to `beta` (PR #141) are **invisible on prod** until
founder promotes `beta → stable → main`. User experiences "bug came back" = **old code still running**.

---

## Secondary amplifiers

- **Ollama down** → RAG embed fails → empty-store class; model fills gap unless guarded.
- **`founder_context.notes` pollution** (2026-06-15) — model wrote advisory junk; `read_context`
  surfaced it as authoritative (mitigated by `context-guard.ts`).
- **`search_web` fallback** for internal Turicks facts — web junk presented as strategy.
- **Inverted QA detectors** (old `weekly-qa-audit.sh`) — flagged honest refusals, missed fabrication.
- **HISTORY_KEEP_TURNS** default drift (config=4, docs say 12) — stale context window mismatch.

---

## Structural fixes (priority order)

1. **Promote beta → main** after green CI + `pnpm hallucination:stress` on VPS.
2. **Gateway seam tests** for `guard.blocked`, `guard.purged`, stale-repeat (h6 stress task).
3. **CI gate:** `pnpm hallucination:stress:quick` on integration job (live key).
4. **State checks on deploy:** `deploy.sh` already runs `brain:sync`; add row-count assert.
5. **Deduplicate ICP** — one doc, seed + sync from that only.
6. **Weekly log-review harvest** (Stage 1–2) on VPS cron — catches fabrication in prod logs.
7. **MTProto e2e** (`scripts/e2e-telegram-qa.ts`) before every `main` promotion.

---

## Verification commands (production)

```bash
# On VPS after deploy
journalctl -u founderos --since "1h" | grep -E 'guard\.(blocked|purged|retry)'
psql $DATABASE_URL -c "SELECT COUNT(*) FROM knowledge_entries;"
psql $DATABASE_URL -c "SELECT COUNT(*) FROM turicks_brain WHERE embedding IS NOT NULL;"
pnpm hallucination:stress:quick
```

Ask twice: "What is Turicks ICP?" — second turn must call tools or refuse; never repeat ARR bands.
