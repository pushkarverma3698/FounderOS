# Instruction Audit

Two distinct instruction systems are being conflated. Separating them is most of the fix.

| System | Audience | Files | Size |
|---|---|---|---|
| **A — Development instructions** | Claude Code / Antigravity building FounderOS | `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `agent-rules.md`, `docs/**` | 1,342 root lines + 22,403 doc lines |
| **B — Runtime prompts** | the FounderOS product serving the founder | `src/kernel/planner.ts`, `src/agents/prompts/*` | ~61k chars |

System A never enters the product's context. System B never enters Claude Code's. **Bloat in each
harms a different thing** — A slows development, B degrades the founder experience.

---

## System A — development instructions

### Classification

| Content | Where it is | Verdict |
|---|---|---|
| Precedence ladder; "a rule not enforced by CI is a convention" | `CLAUDE.md` §Precedence, #27 | **KEEP GLOBAL** — the most valuable paragraph in the repo |
| HITL ordering; determinism; evidence-over-assertion (#24) | `CLAUDE.md` | **KEEP GLOBAL** — safety |
| Rules #28–#33 (approval ≠ verification, review not delegable, …) | `CLAUDE.md` | **KEEP**, but each is self-labelled *"Enforced by: nothing"* |
| Rule #25 deep-ideate + #26 outcome-driven | `CLAUDE.md` | **SCOPE IT** — see below |
| File map, commands, model policy | `CLAUDE.md` | **MOVE TO DOCS** — reference, re-read on demand |
| Prod VPS access block | `CLAUDE.md` | **MOVE TO** `docs/ops/` |
| History / v2 audit narrative | `CLAUDE.md` §History | **MOVE TO DOCS** |
| `JARVIS-ARCHITECTURE.md`, `ZERO-BASE-AUDIT.md`, `ARCHITECTURE_LEDGER.md` at repo root | root | **MOVE TO** `docs/architecture/` |

### The one change that matters most

**Rule #25 (deep-ideate + self-critique) and #26 (outcome-driven) have no size gate.**

The founder's own global instruction already contains the correction —
*"Size the Task Before Applying Any Process"* — and cites the incident: a two-line fix shipped
inside a design proposal with eleven tests and a four-section report. The project `CLAUDE.md` does
not carry that gate, so a Sonnet session reading only project rules applies full architectural
ceremony to a wiring fix.

**Recommended edit** (Phase 8, one paragraph, no rule deleted):

```md
### Scope gate on rules #25 and #26
Both apply to work sized LARGE: new subsystems, schema changes, irreversible actions,
anything touching money/auth/prod data, or work spanning many files.
For a bug fix, a wiring fix, or an edit under ~50 lines whose blast radius you can see:
go straight to the fix. Show the before/after. Ceremony on a small change is the
documented failure, not diligence.
```

### Enforcement asymmetry — the repo's own measurement

`CLAUDE.md` #27 records it: CI-enforced rules drifted **zero** times in a month; markdown rules
drifted **three** times in a day. Yet `governance/architecture-baseline.json` has only five
ratchets and none of the newer rules were converted.

**Convert to CI in Phase 8** (each is a script check, not a prompt):

| Rule | Mechanism |
|---|---|
| Orphan subsystems must not reappear | extend `findOrphanSubsystems` → fail on new zero-importer dirs |
| Every worker must have a verifier | assert `Object.keys(VERIFIERS)` ⊇ `WORKERS` |
| Tools per worker ≤ 12 | new ratchet, baseline at today's counts |
| No dead exported symbol in `src/kernel/` | zero-importer check scoped to kernel |

### Net for System A

| | Before | Target |
|---|---:|---:|
| Root instruction lines | 1,342 | **≤ 450** (`CLAUDE.md` + `AGENTS.md` only) |
| Root `.md` files | 12 | 5 |
| CI ratchets | 5 | 9 |

Nothing is deleted — it moves to `docs/` and is retrieved on demand.

---

## System B — runtime prompts

| Prompt | Chars | Tools | Verdict |
|---|---:|---:|---|
| `supervisor.ts` | 13,459 | — | **DELETE** — dead since the v3 kernel; zero runtime callers |
| `marketing.ts` | 13,138 | 18 | **SPLIT** with the worker (Phase 7) |
| `engineering.ts` | 7,223 | 9 | keep |
| `jobhunt.ts` | 6,319 | 9 | keep — will grow with new job-state tool |
| `personal.ts` | 6,038 | 8 | keep |
| `research.ts` | 5,051 | 12 | trim with tool collapse |
| `comms.ts` | 3,137 | 5 | keep |
| `sales.ts` | 2,803 | 4 | keep |
| `admin.ts` | 2,039 | 14 | **thin prompt, most tools** — highest ambiguity ratio |
| `brand.ts`, `scheduler.ts` | 1,948 | — | keep |

### Planner prompt

~4,300 chars of rules + a catalog of **79 tool slots**, every turn. The 12 behavioural rules are
mostly earned scar tissue (time resolution, draft-vs-send, injection defence) and should stay.

**The catalog is the cost.** Reducing it is Phase 7's job — via D2/D4/D5 in the duplication
audit, not by hiding tools.

### Rules that push the runtime model toward over-work

One is measurable today:

> `- Questions about the founder, their business, work, or history are NOT direct replies: plan a
>   step for the worker with context/memory tools… Read first, then answer`

Correct in intent (it fixed hallucinated answers) but it forces a tool call for *every*
personal-flavoured question, including ones the replayed history already answers. Not urgent —
**Phase 7, measure first with the benchmark.**
