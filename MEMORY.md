# FounderOS — Session Memory Index

> Scannable index only — **not** a restatement of `CLAUDE.md`. Update at the end of any
> session that changed state (`CLAUDE.md` rule #18). This is the canonical, committed
> `MEMORY.md` that rule #18.4 and `docs/rules/PROGRAMMING-RULES.md` Wiring Map 3 refer to.
>
> `.claude/memory/MEMORY.md` is a separate, **archived** v1-era snapshot (2026-05-28) —
> it predates the v2 rebuild and is kept for history only, never as current state.

## Status

- Architecture: v2 (7-department LangGraph supervisor + ReAct workers), PRODUCTION LIVE.
  See `CLAUDE.md` → "Current Phase Status" for the single-source, authoritative phase state
  (this file does not duplicate it).
- Current work: Phase D-Bis (Proof & Distribution) — see `docs/ROADMAP.md`.

## Recent sessions

- 2026-07-06 — Documentation/rule audit (this session): added CLAUDE.md rule #25 + a
  mechanical `verify:test-integrity` CI gate against self-serving/tautological tests
  (`src/infra/test-integrity-check.ts`, `scripts/verify-test-integrity.ts`,
  `docs/rules/TESTING-RULES.md` Rule 15); fixed stale/dangling doc references (this file
  didn't exist before, `SECURITY-RULES-20-21.md` link was missing its path,
  `.claude/README.md` pointed at a non-portable, uncommitted memory path); deduped the
  "PRODUCTION LIVE / architecture locked" paragraph that was repeated verbatim in
  `CLAUDE.md`, `docs/ROADMAP.md`, and `docs/README.md`; corrected stale model-fallback
  text and a duplicated tool-add checklist in `docs/guides/OPERATIONS.md`.

## Known gotchas

- ADR numbering collisions exist: 028, 029, 034, and 035 are each reused by two unrelated
  ADR files under `docs/decisions/`. Flagged, not yet renumbered — check both files when
  citing one of these numbers.
- `pnpm brain:sync` must run after any doc change that should be queryable via
  turicks-brain (rule #18.1).

## File locations

See `CLAUDE.md` → "File Locations Quick Reference" — not duplicated here.
