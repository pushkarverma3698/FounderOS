# Antigravity Delegation — Implementation Briefs

**Purpose:** Antigravity is the implementation engine for wide-and-shallow work. Claude writes the
brief and reviews the result; Antigravity writes the code. This folder holds the briefs.

**Two dispatch paths now exist.** Hand-authored briefs below are still how Claude delegates
laptop-side, conversation-context work. For issue-driven, fully unattended work (GitHub Issue →
Antigravity → PR → Claude review → fix → CI, no founder relay), see
[ISSUE-DRIVEN-CONTRACT.md](ISSUE-DRIVEN-CONTRACT.md) and the `agent:*` label state machine it
defines — driven by the VPS `agent-dispatch` cron, the issue-queue counterpart to `pr-brain`.

> **Contractors build the factory. Once the factory runs, the factory improves itself.**
> Every brief here is Phase 0 bootstrap work. When FounderOS can plan and dispatch its own next
> milestone, these briefs stop being written by hand — see
> [../founderos-v2/06-HANDOFF-CRITERIA.md](../founderos-v2/06-HANDOFF-CRITERIA.md).

## What may be delegated

| Delegate to Antigravity | Keep with Claude / founder |
|---|---|
| Bulk refactors, mechanical multi-file edits | Architecture and contract decisions |
| Boilerplate and scaffolding | Security-sensitive code |
| Test-writing against an existing pattern | Anything needing conversation context |
| Migrations across many files | **All review — without exception** |

The test: *is Claude's reasoning the bottleneck, or just the volume of edits?* Volume → delegate.

## Brief contract

Antigravity has **none** of the conversation's context. Every brief must be self-contained and state:

1. **Goal** — one paragraph, what "done" means
2. **Files in scope** — exact paths, nothing implied
3. **The pattern to follow** — point at a real file already in the repo
4. **Explicitly forbidden** — only what is *task-specific*; the general list lives in STANDARDS.md
5. **Verify command** — the exact command to run, with instructions to report raw output

### Standards live in [STANDARDS.md](STANDARDS.md), not in the brief

**[`docs/antigravity/STANDARDS.md`](STANDARDS.md) is binding on every delegated task** and is read
automatically via the `delegated-task` skill. Purity and I/O placement, resolved-specifier
reachability, named constants, loud-over-silent failure, test discipline, the no-`any`/no-`console.log`/
400-LOC gates, and the close-out contract are all there.

**Briefs must reference it, never restate it.** A rule copied into a brief is a rule that can be
copied *wrong* — which is exactly what happened in AG-001, where the brief specified raw-text
matching and produced two silent false negatives. One file, fixed once, applies to every future task.

When a review finds a defect caused by a missing or wrong general rule, **fix STANDARDS.md**, not
just the code. That is the difference between debugging and not having the bug again.

The Antigravity-side skill `delegated-task`
(`~/.gemini/antigravity/global_skills/delegated-task/SKILL.md`) encodes this contract on its end.
Each brief still restates the specifics.

## Dispatching

Prerequisite: the Antigravity **GUI must be running with this workspace open** —
`agentapi new-conversation` needs a server-side `project_id`. Laptop only; never cron or VPS.

```bash
~/Projects/scripts/ai-tools/agy new --model=pro --title="AG-001 M0a static analyzers" "$(cat docs/antigravity/AG-001-m0a-static-analyzers.md)"
```

Then:

```bash
~/Projects/scripts/ai-tools/agy status <conversation_id>
```

`--model` accepts `pro | flash | flash_lite` only. Address and CSRF token are rediscovered on every
call — nothing is cached, nothing to configure.

## Before you dispatch — review the brief, not just the diff

**The brief is the primary defect surface.** Of the ten defects found across AG-001…AG-006, **six
were defects in the brief** and only four were Antigravity departing from its instructions. AG-005
and AG-006 had *zero* spec violations — every problem in them was authored upstream, by Claude.

Writing a sharper brief is therefore worth more than any amount of extra instruction to the
executor. Before dispatch, check the brief against the four questions that actually caught things:

1. **Does the target already exist?** Grep before specifying. AG-001 specified raw-text matching
   when a correct resolver was already required by STANDARDS §3.
2. **Is every literal in the brief measured, not remembered?** The AG-004 `doc-claims-ci` baseline
   was pinned at `1` from memory; the real count was `7`, and the rule as written could not have
   seen the three violations it existed to catch. Run the count, paste the number.
3. **Does the brief claim anything about files it is not opening?** AG-005 asserted nothing unique
   would be lost by retiring `.cursorrules`; it was in fact the only pointer to seven `docs/rules/`
   files.
4. **Is the granularity right?** AG-006 specified item-granular truncation where evidence-granular
   was needed, so one oversized finding rendered as a header and nothing else.

A brief that fails any of these produces a faithful implementation of the wrong thing — which costs
more than a visible failure, because it looks green.

## Review discipline — non-negotiable

**The executor is never its own grader.** `agy` has no way to grade Antigravity's output, and its
own help text says so.

### Step 0 — confirm it actually stopped, then commit before reading

```bash
~/Projects/scripts/ai-tools/agy-guard && git add -A && git commit -m "wip: AG-NNN as delivered"
```

`agy-guard` exits non-zero if any conversation ledger in `~/.gemini/antigravity/conversations/`
was written in the last 3 minutes. **"It's done" is a claim about the past, not a lock on the tree.**

*(2026-08-06: AG-004 reported done at ~20:24. Review ran at 20:27 against 16 failing tests. At
20:36:21 the still-live conversation reverted its own work and rebuilt. A ledger was still being
written at 20:39 — fifteen minutes after "done." Claude's unrelated edits at 20:38 were one write
away from being clobbered the same way; only an intervening commit saved them.)*

Commit **before** reading, not after. The commit is what makes a review reproducible; without it
you are reviewing a moving target and cannot prove afterwards what you saw.

### Then

1. Read `git diff` yourself — all of it.
2. Run the brief's verify command yourself and read the raw output.
3. Check the forbidden list was actually respected — in particular STANDARDS §11's git rules and
   §13's stop-don't-clean-up rule.

**Never accept Antigravity's summary as "done."** A green summary over a red diff is the failure
mode this rule exists to prevent. Across six briefs, Antigravity self-caught **0 of 10** defects —
so the review is not a formality on top of the work, it *is* the quality mechanism.

## Brief index

| ID | Title | Milestone | Status |
|---|---|---|---|
| [AG-001](AG-001-m0a-static-analyzers.md) | M0a static analyzers (prompt bloat, untested modules, LOC pressure) | M0a | **merged** — implemented faithfully; 2 defects found, both traced to a wrong rule in this brief, superseded by AG-002 |
| [AG-002](AG-002-untested-module-resolution.md) | Fix `findUntestedModules` to use resolved specifiers, not raw text | M0a | **merged** — reviewed 2026-08-06: `resolveImport` exported and reused, both collision regressions green, 30 tests / lint / arch all green |
| [AG-003](AG-003-telemetry-analyzers.md) | M0a telemetry analyzers — cost hotspots, recurring failures, unapplied lessons | M0a | **merged** — reviewed 2026-08-06: pure, `Number.isFinite` guard present; 2 output-ordering fixes applied on review |
| [AG-004](AG-004-fitness-rules-lock.md) | Five new fitness rules + escape-hatch tag (the drift lock) | cross-cutting | **rejected — needs rewrite before re-dispatch** (see below) |
| [AG-005](AG-005-instruction-file-precedence.md) | GEMINI.md, precedence order, retire `.cursorrules` | cross-cutting | **merged** — reviewed 2026-08-06: zero spec violations; one brief defect found on review (`.cursorrules` was the only pointer to `docs/rules/`), fixed by a pointer in `AGENTS.md` |
| [AG-006](AG-006-rank-and-report.md) | M0a output surface — `rankFindings` + `renderReport` | M0a | **merged** — reviewed 2026-08-06: zero spec violations; three fixes applied on review (evidence-granular truncation, `localeCompare`→codepoint, plural) |
| [AG-007](AG-007-typecheck-tests.md) | Bring `tests/` under `pnpm lint` — 109 errors / 34 files | cross-cutting | **merged** — verified 2026-08-06: tsconfig.test.json added, 109 type errors across 34 test files fixed, zero `any` or `@ts-ignore` bypasses, `pnpm gate` 100% green |
| [Handoff M0b](CLAUDE-CODE-HANDOFF-AG-007-M0A.md) | Handoff Brief to Claude Code for M0b (Mission & Outcome DB Persistence) | M0b | **ready to dispatch** — all AG-007 & M0a work completed, 2,550 tests green, prompt ready |

### AG-004 must be rewritten before it is re-dispatched

Two independent problems, both authored upstream:

1. **The `doc-claims-ci` rule is dropped** (founder decision, 2026-08-06) — five rules become four:
   `analyzer-purity` 0, `text-reachability` 0, `no-explicit-any` 10, `no-console-log` 0. The rule's
   baseline was pinned at `1` from memory against `.cursorrules`, a file that is not `*.md` and was
   never in scope; the real count was 7, all benign, and the regex could not have matched the three
   present-tense claims it existed to catch.
2. **The delivered result was 16 failing tests against five unimplemented exports**, and then — nine
   minutes after reporting done — a self-revert to `HEAD` plus a full rebuild. `scripts/verify-architecture.ts`
   was byte-unchanged throughout. STANDARDS §13 now names this fork explicitly; it did not exist at
   dispatch time (STANDARDS.md was written at 20:24, five minutes after AG-004 went out), so this is
   an untested rule, not a proven-broken one.

**Dispatch [AG-007](AG-007-typecheck-tests.md) before re-dispatching AG-004.** AG-004's failure mode
was tests-without-implementation passing `pnpm lint`; AG-007 is the mechanism that makes that
mechanically impossible rather than dependent on a reviewer noticing.

**AG-005 / AG-006 were dispatched in parallel and that worked** — disjoint file sets, no interference.
AG-007 owns `tsconfig.test.json` + `package.json` + `tests/`; a rewritten AG-004 owns `scripts/` +
`governance/`. Those are disjoint too, **but do not run them together**: both change what `pnpm lint`
and `pnpm verify:arch` report, so a failure in either becomes unattributable. Serial, AG-007 first.

## Status vocabulary

`ready to dispatch` → `dispatched` → `awaiting review` → `merged` / `rejected`

A brief is only `merged` after a human read the diff and re-ran verify.
