# AG-061 — Prune docs, rules and env keys; close superseded PRs

**Source:** [docs/plans/2026-10-08-simplify-founderos.md](../plans/2026-10-08-simplify-founderos.md) task AG-061.
**Depends on:** AG-057 (the old turn path is gone, so rules about it can go).
**Branch:** `task/issue-<N>-docs-prune`, cut from `origin/beta`. PR base: `beta`.
**Depth:** Lite. Docs and config only. It becomes Full if an env key removal changes a deploy script.
**Moves:** none directly. Agents stop reading rules for code that no longer exists.

Read [STANDARDS.md](STANDARDS.md) before editing.

## Goal

An agent that opens the repo reads the current system: one CLAUDE.md file map, one live plan, and rules that point at
code that exists.

## Problem (measured)

- 359 markdown files in `docs/`: 52 plans, 65 session notes, 9 rule files and 4 path rules.
- CLAUDE.md still describes planner → supervisor → worker → synthesizer, and "20 tables" (prod has 43).
- 87 keys in `.env.example`. Some are read by no code.
- Draft PRs left open by earlier plans: #1010, #1002, #923, #984, #1006, #991 (if AG-054 has taken its override).

## Expected behavior

1. **CLAUDE.md, AGENTS.md, GEMINI.md**: the architecture block and file map describe the loop, the registry and one
   memory table. Remove the anti-slop items and rules that point at deleted modules. Keep each rationale entry an
   incident still backs.
2. **Plans.** Move every plan in `docs/plans/` that is finished or superseded to `docs/plans/archive/`, with a one-line
   index giving each plan's fate. Only the simplify plan and its successors stay at the top level.
3. **Session notes** older than 30 days move to `docs/sessions/archive/`. Do not delete them; they are episodic memory.
4. **Env keys.** For each key in `.env.example`, grep for readers in `src/`, `scripts/` and `deploy/`. Remove a key
   only when no code reads it, and paste the list. `scripts/apply-prod-env-overrides.sh` must not set a removed key.
5. **Close superseded PRs** with a comment that links the simplify plan and names the brief that replaced each one.

## Files in scope

`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `docs/`, `.claude/rules/`, `.env.example`, `scripts/apply-prod-env-overrides.sh`.

## Constraints

- `pnpm verify:doc-claims` passes: no doc claims a file or function that is not there.
- Moving files keeps git history (`git mv`).
- No secrets in any doc.

## Explicitly forbidden

- Deleting session notes or ADRs.
- Rewriting rules that still have an enforcing mechanism (CI, a hook or a script) without changing that mechanism in
  the same PR.

## Verification commands

```bash
pnpm gate
pnpm verify:doc-claims
```

## Acceptance criteria

- The count of top-level `docs/plans/*.md` files and `.env.example` keys, before and after.
- A fresh Claude session given only "what does FounderOS do and where is the turn path?" answers from CLAUDE.md
  without opening a deleted file. Paste the answer.
