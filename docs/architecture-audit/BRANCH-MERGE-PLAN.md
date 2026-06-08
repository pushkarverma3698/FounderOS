# Branch Merge Plan
**Date:** 2026-06-05

---

## Branch Situation

### Active branches (relevant)

| Branch | Status | Notes |
|---|---|---|
| `main` | Production baseline | 10 commits behind `feat/qa-production-hardening` |
| `feat/qa-production-hardening` | **THE branch to merge** | 10 commits ahead of main, 614 tests green |
| `feat/test-coverage-and-new-tools` | Obsolete | See below |

### `feat/test-coverage-and-new-tools` — Why it's obsolete

This branch has **one unique commit** (`1cd86c3`) on top of an older base. That commit introduced:
- `src/tools/email-reader.ts`
- `src/gateway/status.ts` + `context-command.ts`
- `src/outbound/targets.ts` + `batch.ts`
- Test coverage for telegram-utils, scheduler, linkedin, github

**Every one of those files exists in `feat/qa-production-hardening`** — either as-is or in an improved form. The QA branch has 57 test files (614 tests) vs the test-coverage branch's 21 files (131 tests). The test-coverage branch is a strict subset.

**Do not merge `feat/test-coverage-and-new-tools` — it would be a regression.** It can be safely deleted after `feat/qa-production-hardening` lands on main.

---

## Merge Plan

### Step 1 — Complete work on `feat/qa-production-hardening` (current)
- [x] Architecture audit + simplification fixes (this session)
- [x] Uncommitted changes committed (engineering.ts github_read expansion + system-prompts research-only workflow)
- [ ] Run `pnpm test` → must be 614+ green
- [ ] Run `pnpm lint` → must be clean
- [ ] Push branch

### Step 2 — Open PR to main
```bash
gh pr create \
  --title "feat(qa): production hardening, simplification fixes, architecture audit" \
  --base main \
  --head feat/qa-production-hardening
```

PR covers:
- 503 model cascade fallback
- Google Calendar tool (Composio)
- P0 email/linkedin phantom-success fix
- 8→7 department merge (no duplicate tool owners)
- agent-tools.ts split into per-department modules
- Docs reorg (guides/ + rules/)
- HITL gate helper (`hitlGate()`)
- commands.ts extraction
- pre-router.ts pure functions
- Workflow/SOP engine + `/run` + `/q` commands
- 48 edge-case tests (hitlGate, webSearch, knowledge tools)
- **Architecture simplification:** Redis gated, CLAUDE.md corrected, schema annotated

### Step 3 — Human approves + merges PR

### Step 4 — Cleanup
```bash
git branch -d feat/test-coverage-and-new-tools
```

---

## Which Branch to Do Work In?

**Always `feat/qa-production-hardening`.** It is the canonical working branch that will become the next main. The test-coverage branch is read-only history at this point.

---

## Divergence Point

Both branches share ancestor `478145a` (merge of `fix/telegram-reliability-wedged-interrupt`).  
`feat/qa-production-hardening` has 10 commits on top.  
`feat/test-coverage-and-new-tools` has 1 commit on top (the older test-coverage commit predates the telegram-reliability merge and is a different base entirely — it forked from even earlier).
