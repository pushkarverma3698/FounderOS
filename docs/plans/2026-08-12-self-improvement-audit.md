# Self-Improvement Audit — can FounderOS improve itself?

**Date:** 2026-08-12 · **Branch:** `claude/production-logs-audit-8tkzw0` · **HEAD:** `0716424`
**Question asked:** *"How can we say we are a self-improving system when it cannot improve itself?"*

**Answer:** We cannot say it. Not because the machinery is missing — it is all built — but because
the loop is **cut in three places**, and each cut is a single, nameable line of code.

---

## 0. Verification boundary (read this before citing anything below)

`ssh` is **not installed in this container**, so I could not reach the prod VPS. Nothing in this
document is a claim about live prod behaviour.

| Claim class | Status |
|---|---|
| Repo state at `0716424` | **VERIFIED** — greps, file reads, executed scripts, this session |
| Test suite | **VERIFIED** — `pnpm test`: 272 files, **2862 passed**, 95.8s |
| Self-audit output | **VERIFIED** — `scripts/audit-self.ts` executed live (static half) |
| Acting-loop selection | **VERIFIED** — replicated `self-improve-cron.ts` selection exactly |
| Prod DB row counts, journald, funnel throughput | **NOT VERIFIED — no prod access this session** |

Where I reuse a number from the 2026-08-08 audit (`docs/product-recovery/`), it is labelled as
*that document's* measurement, not mine. Per rule #31, a status relayed through a document is
still unverified.

---

## 1. What actually shipped since the 2026-08-08 audit — verified fixed

Credit first. Nine of the ledger's defects are genuinely closed at HEAD. I checked each one.

| ID | Defect | Evidence at HEAD |
|---|---|---|
| F-08 | `VERIFIERS` covered 1 of 8 workers | **8 of 8** — `src/kernel/verify.ts:76` (comms, marketing, sales, admin, jobhunt, engineering, research, personal) |
| F-09 | `writeTaskOutcome` had zero callers | **Called** — `src/kernel/synthesizer.ts:100` |
| F-12 | No mission-level completion check | **Exists** — `src/kernel/mission-satisfaction.ts`, called `synthesizer.ts:70` |
| F-03 | "Mission complete" on unmet objective | Guarded by the two above |
| F-05/06 | Artifact create→deliver path broken | `deliver_artifact` receipt now **required** for jobhunt CSV — `verify.ts:60-70` |
| F-01 | Free lane age gate = 6h dropped 99.9% | **720h** — `src/tools/jobhunt/free-ingest.ts:72` |
| F-02 | Funnel drop reasons computed then discarded | **Surfaced as notes** — `free-ingest.ts:162-168, 237-239` |
| F-07 | `synthesize_skill` wrote code with no gate | **`hitlGate()` before first write** (`skill-synthesizer.ts:91`) **+ `SKILL_SYNTHESIS_ENABLED` flag** (`kernel-boot.ts:94`) |
| F-24 | Postgres restart crash-looped the bot | **`_pool.on("error")`** — `src/db/client.ts:76` |

That is real work and the execution substrate is in better shape than the audit describes.
**It does not touch the self-improvement question**, which is why the founder can feel the
system standing still while the ledger shrinks.

---

## 2. The self-improvement machinery, as actually wired

There are **two** loops, and neither is the one we describe when we say "self-improving."

### Loop A — the one that runs. It observes and cannot act.

```
cron "0 8 */3 * *"  (src/infra/scheduler.ts:310)
  → runSelfAuditSweep()          (src/evolution/audit-sweep.ts)
  → runSelfAudit()               (scripts/audit-self.ts:103)
  → sendToChat(report)           ← TERMINATES HERE
```

`audit-sweep.ts` is 22 lines. Its entire body is: build report, send to Telegram, log. There is
**no branch that changes any file, opens any issue, or writes any row.** Every three days it
produces a message and stops.

### Loop B — the one that acts. It is not scheduled, and it is blind.

```
pnpm self-improve:run            ← MANUAL ONLY
  → runSelfImprovementLoop()     (scripts/self-improve-cron.ts:29)
  → 4 static analyzers → rankFindings() → .slice(0, 3)
  → claudeCodeTool.execute(prompt)   ← writes code
```

**Verified:** `runSelfImprovementLoop` is referenced in exactly two places — its own
`import.meta.url` main guard, and `package.json`. It appears in **no cron, no systemd timer, no
workflow, no deploy script.** The only component in FounderOS that can modify FounderOS runs
only when a human types a command.

---

## 3. The three cuts

### Cut 1 — The acting loop cannot see a single outcome signal

`self-improve-cron.ts:16-22` imports exactly four analyzers:

```ts
findDeadExports · findOrphanModules · findOversizedPrompts · findUntestedModules
```

All four are **filesystem-only**. It never imports `collect-telemetry.js` or
`analyzers/telemetry.js`. It therefore cannot produce a `cost-hotspot`, `recurring-failure`, or
`unapplied-lesson` finding — **even with a healthy database.**

Now read our own ranker, `src/evolution/rank.ts:20`:

```ts
export const KIND_PRIORITY = [
  "unapplied-lesson",   // ← 1st
  "cost-hotspot",       // ← 2nd
  "recurring-failure",  // ← 3rd
  "unused-dependency", "orphan-module", "dead-export",
  "oversized-prompt", "loc-pressure", "untested-module",
];
```

The three kinds the acting loop is structurally incapable of generating are the **three we
ranked highest**. The file's own comment says *"Money and silent defects first; tidiness last."*
The loop that acts can only ever act on tidiness.

**Measured, this session.** I replicated the loop's selection exactly:

```
Acting loop sees 289 findings; telemetry-kind findings: 0

TOP 3 — what Claude Code is actually told to fix:
  1. [MEDIUM] orphan-module  src/core/companies.ts
  2. [MEDIUM] orphan-module  src/db/entity-graph.ts
  3. [MEDIUM] orphan-module  src/db/schema/entity-graph-schema.ts

Kind histogram: {"orphan-module":21,"oversized-prompt":1,"dead-export":167,"untested-module":100}
```

If we ran the autonomous self-improvement loop today, it would spend a Claude Code invocation —
with `--permission-mode acceptEdits` and `Bash Edit Write` allowed (`claude-code.ts:73,286`) — on
deleting three unimported modules. Not one founder outcome would move. Note also that **no
finding is HIGH**: the loop omits `findOrphanSubsystems` and `findFilesNearLocBudget`, which are
the analyzers that produce HIGH severity in the reporting path.

### Cut 2 — Findings are never persisted, so nothing can compound

**Verified:** there is no findings table anywhere in the schema — 26 `.table()` declarations in
`src/db/schema.ts` plus 2 `pgTable()` in `src/db/schema/entity-graph-schema.ts`, none of them — and
there is **no `insert` anywhere in `src/evolution/` or either entry script.**

Every self-audit starts from zero. The system cannot distinguish:

- a finding that is **new** this cycle,
- a finding that has **recurred 40 times** and is being ignored,
- a finding that was **fixed and has regressed**.

This is carried item **C-02** from 2026-08-07, still fully open. Improvement that does not
remember cannot compound — it can only repeat. Three days from now, Loop A will send a message
containing these same 316 findings, and there is no mechanism by which that message differs from
the last one.

### Cut 3 — The learning seam records only failures it already solved

This is the subtlest cut and the most damaging.

`src/kernel/lessons.ts:124` — Hook 1 writes a lesson **only** under:

```ts
if (settled?.status === "ok") { await lessons.record({...}) }
```

`upsertFailureLesson` (`src/db/queries.ts:1456`) is called from nowhere else. So the row is
written **only when a retry succeeded**, and `times_seen` (`queries.ts:1471`) increments on
*resolutions*, not on *occurrences*.

`failure_lessons` is therefore **a success log, not a failure log.**

The consequences compound:

1. A step that fails the same way 500 times and never recovers writes **zero rows**. The failures
   most worth learning from are exactly the ones the store cannot see.
2. `findRecurringFailures` reads `failure_lessons` — so it can only detect components that failed
   in ≥3 distinct ways **and recovered from each**. A permanently broken component is invisible
   to the recurring-failure analyzer.
3. `findUnappliedLessons` requires `times_seen >= 3`. The 2026-08-08 audit measured **2 rows
   total** in prod. With 2 rows, no lesson finding can fire at all.

The Phase 11 spec already names this: *"Feed verification failures into the lesson store —
currently only retry failures reach it, which is why there are 2."* It has not shipped.

---

## 4. Where we are lagging — the honest ranking

**The binding constraint is not any of the three cuts. It is that we still have no baseline.**

`docs/product-recovery/benchmark-runs/` contains exactly one file, and its first line reads:

> `# ⛔ REJECTED — THIS IS NOT A BASELINE`

Four days after F-23 established that the Phase 0 baseline was authored rather than measured, and
after `pnpm verify:benchmark` was built to prevent a repeat, **no measured baseline has been
produced.** The gate exists; it has never been passed.

This outranks everything else because it is upstream of everything else. Until a real baseline
exists, "Phase N improved X" is unfalsifiable for all twelve phases — which is precisely the
failure F-23 was written to prevent, now recurring as inaction rather than fabrication.

| # | Lag | Severity | Verified |
|---|---|---|---|
| 1 | **No measured baseline exists.** Phase 0 gate never passed | **P0** | ✅ only the REJECTED file |
| 2 | Acting loop cannot see telemetry — 0 of 289 findings | **P0** | ✅ measured |
| 3 | Acting loop is unscheduled — manual only | **P0** | ✅ zero cron references |
| 4 | Findings never persisted — cannot compound (C-02) | **P0** | ✅ no table, no insert |
| 5 | Lesson store records only resolved failures | **P1** | ✅ code-traced |
| 6 | Synthesized skills can never load (see §5) | **P1** | ✅ code-traced |
| 7 | `context-composer.ts` still zero importers (F-10) | **P1** | ✅ grep empty |
| 8 | Free-lane live throughput after the 720h fix | **unknown** | ❌ no prod access |

Items 2–5 are each a small, bounded change. Item 1 is not a code change at all — it is 34 prompts
typed into Telegram and scored. **That is why it has not happened, and why it must happen first.**

---

## 5. Hermes — how agent/skill synthesis actually works here

Two unrelated subsystems carry the Hermes name. Neither is a browser agent, a skill layer, or a
competing orchestrator — the strategy docs describe a Hermes this repository does not contain.

### 5a. The Hermes learning seam — `src/kernel/lessons.ts` (wired, starved)

A decorator around the **pure** `dispatch` node, injected at `graph.ts:23`. Two hooks:

**Hook 2 — on retry.** When dispatch builds a retry, the failure message is normalised into a
stable signature (`normalizeFailureSignature`: lowercases, then collapses UUIDs → `<uuid>`,
hashes → `<hash>`, URLs, emails, long quoted payloads, and *all digits* → `<n>`, capped at 200
chars). That signature is looked up in the injected `LessonStore`. On a hit, **one deterministic
sentence** is appended to the retry envelope as a `HumanMessage`:

> `KNOWN FAILURE PATTERN (seen 4×, last resolved 2026-08-02): this same error was previously
> overcome by a corrected attempt using: write_artifact, deliver_artifact. Original context:
> "…". Apply the same correction instead of repeating the failed approach.`

This is **evidence appended to context, not a prompt rewrite.** The prompt is never mutated, so
determinism holds.

**Hook 1 — on settlement.** The retry's stashed candidate is checked; if the step later validated
`ok`, the `(worker, signature) → tools that resolved it` pair is recorded. Only successful
`ToolReceipts` count, and receipts are written **by code** in `worker.ts`, so the model cannot
forge one.

Discrimination is **structural, not heuristic** — only dispatch's retry branch emits a
`results: { set }` update, which is what the decorator keys on. Every store call is wrapped in
`try/catch` with an `// allow-failopen:` tag: a Postgres blip degrades to "no lesson", never to a
broken turn. `times_applied` is incremented on lookup (`kernel-boot.ts:124`) so we can tell a
lesson that is consulted from one that merely exists.

**Assessment: correctly built, correctly wired, and starved by Cut 3.** It only remembers what it
already fixed.

### 5b. The Hermes skill synthesizer — `src/tools/skill-synthesizer.ts` (writes into a void)

Exposed as `synthesize_skill` on **admin** and **engineering** (`capabilities.ts:105,108`) and on
the `coder` sub-agent (`:117`). The flow:

1. `hitlGate()` fires **before the first filesystem write** — founder sees the tool name, a
   char count, and a 2,000-char preview of the code. Correct ordering, and the in-file comment
   correctly notes that `HITL_GATED_TOOLS` membership is *declarative only*; this inline call is
   the real gate.
2. `SKILL_SYNTHESIS_ENABLED !== "true"` removes the tool from the catalog entirely at boot.
3. Name is sanitised to `[a-z0-9_-]`; code is written to `src/tools/custom/<name>.ts`, optional
   test to `tests/unit/tools/custom/<name>.test.ts`.
4. `tsc --noEmit` runs over the whole project. **On failure the file is unlinked** — invalid
   TypeScript is never left behind. (Both paths are covered by
   `tests/unit/tools/skill-synthesizer.test.ts`, which passed this session.)

**And then nothing happens.**

The tool's own description says it will *"synthesize and **register** a new custom TypeScript tool
module."* **There is no registration step.** Verified this session:

- `src/tools/custom/` is **empty** (the directory only exists because the test run created it)
- **nothing** imports `src/tools/custom` — the only mention of the path anywhere outside the
  synthesizer is a comment in `src/core/config.ts:296`
- there is **no `readdir` / dynamic tool scan** in `src/agents/`, `src/gateway/`, or `src/kernel/`
- `DEPARTMENT_TOOLS` (`capabilities.ts:104`) is a **static, hand-written map** of imported
  symbols; the only dynamic merge is `applyMcpBridge`, which is for external MCP servers

So a synthesized skill is written, typechecked, and orphaned. A restart does not load it — the
registry is a literal. The **only** way it becomes callable is a human editing
`capabilities.ts` to import it and redeploying.

**This is the sharpest single answer to the founder's question.** The one mechanism in FounderOS
that would genuinely constitute self-improvement — the system authoring itself a new capability —
terminates in a file nothing can reach. Worse, on success it reports:

> `✅ Skill "x" successfully synthesized, typechecked, and saved to …`

which is true about the write and misleading about the capability, and lands squarely in the
class of defect the ledger calls **"tool succeeded ≠ objective succeeded."** Note the asymmetry:
the typecheck failure path is honest and self-cleaning, while the success path overclaims.

---

## 6. So what can we honestly say?

**Defensible today:** *"FounderOS audits itself on a schedule and reports what it finds."* Loop A
is real, runs every three days, and its failure paths were deliberately built so that "did not
run" never renders as "came back clean" (`self-improvement-wiring.test.ts`). That discipline is
genuinely good and rare.

**Not defensible:** *"FounderOS is self-improving."* Improvement requires that the system
**change** something, **remember** that it changed it, and **know whether the change helped.**
At HEAD it does none of the three: the acting loop is unscheduled and outcome-blind, findings are
never persisted, and no baseline exists to measure against.

The most accurate description of the current state is: **a well-built sensor with the actuator
disconnected, reporting into a room with no memory.**

---

## 7. Recommended order (ranked, not a survey)

Ordered by *what unblocks the most downstream truth*, not by effort.

1. **Run the 34-prompt benchmark against prod and pass `pnpm verify:benchmark`.** No code. This is
   the binding constraint — every other item's value is unmeasurable until it exists.
2. **Add the telemetry analyzers to `self-improve-cron.ts`** (3 imports + 2 collector calls,
   mirroring `audit-self.ts:60-80`). Without this, automating Loop B would be actively harmful —
   it would burn paid invocations on tidiness at `acceptEdits` permission.
3. **Persist findings** — one table, `(kind, subject, first_seen, last_seen, times_seen,
   resolved_at)`, written by both loops. This closes C-02 and is what makes "is this getting
   better?" answerable at all.
4. **Feed verification failures into the lesson store** (Phase 11, item 4). Turns
   `failure_lessons` from a success log into a failure log and un-starves 5a.
5. **Decide `synthesize_skill`'s fate.** Either implement loading (a `readdir` over
   `src/tools/custom` merged into `DEPARTMENT_TOOLS` at boot, gated by the existing flag), or fix
   the description and success message to stop claiming registration. Shipping neither is the
   only wrong answer.
6. **Only then schedule Loop B** — and gate it behind a founder-approved PR rather than direct
   `acceptEdits` on the running tree.

Items 2–5 are each well under a day. Item 1 is the one only the founder can start.
