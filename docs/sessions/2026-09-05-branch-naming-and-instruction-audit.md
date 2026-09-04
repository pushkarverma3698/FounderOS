# 2026-09-05 — Branch naming rules + instruction-surface audit

## What we did

Added a binding **naming grammar** to `docs/antigravity/BRANCHING-STRATEGY.md` (the doc already
existed and was already pointed to as binding from `AGENTS.md` and `GEMINI.md` — extended it rather
than writing a fourth copy), gave it a mechanism, and pointed the three agent instruction files at
it in one line each.

- `docs/antigravity/BRANCHING-STRATEGY.md` — new § "Naming grammar — BINDING": three legal shapes,
  slug rules, 60-char cap, worked ✅/❌ table, and an explicit ban on harness codenames. Prefix
  table extended with `claude/`, `cursor/`, `antigravity/`, `refactor/`, `test/` (the first three
  were in daily use and were **not in the binding table at all**).
- `scripts/verify-branch-name.sh` + `pnpm verify:branch`, wired as the first step of `pnpm gate`.
  No-ops on `main`, `beta`, and detached CI checkouts; reads `GITHUB_HEAD_REF` in Actions.
- `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` — one-line pointers, no restatement of the rules.
- Renamed this session's own branch `claude/branch-naming-audit-ac9712` →
  `claude/docs-branch-naming-rules`, because the new rule failed it.

## What we fixed

The observed defect was **branch names carrying zero information**. Five harness codenames have
already merged to `main`: `claude/sweet-pike-6b0c3c`, `claude/wonderful-spence-d76aa2`,
`claude/sad-burnell-86737c`, `claude/funny-fermat-552ryl`, `claude/portfolio-ai-audit-kjik0f`.
Nothing in "sweet-pike" recalls what shipped in it, so the history is unsearchable by branch.

Secondary: the binding doc's prefix table listed `feat/ fix/ hotfix/ chore/ docs/ task/` while every
agent in the repo was cutting `claude/*` and `cursor/*`. The rule and the practice disagreed, which
is how a binding doc becomes decoration.

## Why

Rule #27 — a rule with no mechanism decays. The previous branching doc said explicitly "no new CI
gate … enforced by discipline", and discipline produced five codename branches. `pnpm verify:branch`
converts the naming half from layer 5 (reference) to layer 2 (enforced), which is the only layer
this repo has measured as drift-free.

## Metrics

- Validator tested against 11 branch names (5 real, 6 synthetic): correct verdict on all 11.
- Always-loaded instruction surface measured at **84,960 chars ≈ 21,240 tokens/session**
  (global `CLAUDE.md` 28,117 · `rules/ecc/common/*.md` ×10 16,743 · project `CLAUDE.md` 21,707 ·
  `MEMORY.md` 18,393).

## Outstanding

Instruction-surface audit findings, **reported not fixed** (they live in the founder's global
`~/.claude/` config, which spans every project — his call, not this session's):

1. The MANDATORY Ollama routing block instructs every session to call `qwen2.5:7b` /
   `qwen2.5-coder:7b`. `GET localhost:11434/api/tags` returns **only `nomic-embed-text`** — 3 of the
   4 table rows 404. Stated three times in global `CLAUDE.md` (lines 3, 92, 150), one of them
   flagged ⚠️ NON-NEGOTIABLE.
2. **12 references to 9 agents that do not exist.** `~/.claude/agents/` holds exactly
   `code-reviewer`, `debugger`, `security-reviewer`; the other 202 are in `agents-disabled/`.
   Dead: `tdd-guide` (×4), `planner` (×2), `architect`, `build-error-resolver`,
   `typescript-reviewer`, `python-reviewer`, `go-reviewer`, `rust-reviewer`.
3. **Contradiction** — project `CLAUDE.md` line 54 "no src file over 400 lines" (CI-enforced) vs
   `rules/ecc/common/coding-style.md` "800 max" and `code-review.md` "<800 lines" (unenforced).
4. Same concept restated: code-quality checklist ×3, TDD/80%-coverage across 5 files,
   "outcome-driven" near-verbatim in both global and project `CLAUDE.md` with the same 2026-07-31
   anecdote.
5. 2,113 **byte-identical** trailing bytes in `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` (Strategic
   Mandate · No AI Slop · Implementation Plans · Cross-Agent Awareness). `GEMINI.md` itself warns
   "a partial copy is how the four files this repo just consolidated drifted apart" — these four
   blocks are exactly that shape.
