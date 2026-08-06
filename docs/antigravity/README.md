# Antigravity Delegation — Implementation Briefs

**Purpose:** Antigravity is the implementation engine for wide-and-shallow work. Claude writes the
brief and reviews the result; Antigravity writes the code. This folder holds the briefs.

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
4. **Explicitly forbidden** — what must not be touched or changed
5. **Verify command** — the exact command to run, with instructions to report raw output

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

## Review discipline — non-negotiable

**The executor is never its own grader.** `agy` has no way to grade Antigravity's output, and its
own help text says so. Close every delegated task by:

1. Reading `git diff` yourself — all of it.
2. Running the brief's verify command yourself and reading the raw output.
3. Checking the forbidden list was actually respected.

**Never accept Antigravity's summary as "done."** A green summary over a red diff is the failure
mode this rule exists to prevent.

## Brief index

| ID | Title | Milestone | Status |
|---|---|---|---|
| [AG-001](AG-001-m0a-static-analyzers.md) | M0a static analyzers (prompt bloat, untested modules, LOC pressure) | M0a | **merged** — implemented faithfully; 2 defects found, both traced to a wrong rule in this brief, superseded by AG-002 |
| [AG-002](AG-002-untested-module-resolution.md) | Fix `findUntestedModules` to use resolved specifiers, not raw text | M0a | **merged** — reviewed 2026-08-06: `resolveImport` exported and reused, both collision regressions green, 30 tests / lint / arch all green |
| [AG-003](AG-003-telemetry-analyzers.md) | M0a telemetry analyzers — cost hotspots, recurring failures, unapplied lessons | M0a | **ready to dispatch** |

## Status vocabulary

`ready to dispatch` → `dispatched` → `awaiting review` → `merged` / `rejected`

A brief is only `merged` after a human read the diff and re-ran verify.
