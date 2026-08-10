# AG-005 — One source of truth: GEMINI.md, precedence order, retire .cursorrules

**Repository:** `/Users/pushkarverma/Projects/founderos`
**Branch:** `feat/m0a-evolution-engine-v0` (already exists — commit onto it, do not create a new one)
**Standards:** read **[`docs/antigravity/STANDARDS.md`](STANDARDS.md)** in full first. It is binding.
**Design:** `docs/superpowers/specs/2026-08-06-lock-code-practices-design.md` (approved)

---

## Goal

Four files currently claim authority over how code is written in this repo — `CLAUDE.md`,
`AGENTS.md`, `.cursorrules`, `docs/antigravity/STANDARDS.md` — with **no stated precedence**, and
they have measurably drifted apart. This task makes the set consistent and adds the one file that is
missing.

This is a **documentation-only** task. You will not write or modify any TypeScript.

"Done" means: `GEMINI.md` exists, the precedence block appears verbatim in four files,
`.cursorrules` no longer asserts things that are false, `AGENTS.md`'s stale test count is corrected,
and the verify command below is green.

---

## The four defects being fixed

1. **`.cursorrules` §6 is false.** Its heading reads
   `## 6. Git & PR policy (CI-enforced by .github/workflows/branch-policy.yml)`. That workflow was
   **deleted on 2026-08-01** by founder directive — verified: `.github/workflows/` contains only
   `ci.yml`, `deploy.yml`, `live-check.yml`, `live-e2e.yml`, `sync-beta.yml`, `vps-gws-install.yml`,
   `vps-verify.yml`. The file has claimed a non-existent protection for three weeks.
2. **`AGENTS.md` says "~1100 tests".** The real number, measured this session, is **2540** across
   243 files.
3. **No `GEMINI.md` exists.** Antigravity is Gemini-based. The only thing currently pointing it at
   `STANDARDS.md` is `~/.gemini/antigravity/global_skills/delegated-task/SKILL.md` — a file **outside
   this repository**, unversioned, and absent on any other machine.
4. **No precedence is stated anywhere.** When these files disagree — and defect 1 proves they
   already do — nothing says which wins.

---

## Task 1 — Create `GEMINI.md` at the repository root

New file. Keep it short: it is a router, not a rulebook. It must contain, in this order:

1. A one-paragraph statement of what FounderOS is. Copy the framing from the top of `CLAUDE.md`
   ("a deterministic agent kernel with a Telegram gateway") — do not invent a new description.
2. **The precedence block**, verbatim as given in Task 2 below.
3. A pointer to `docs/antigravity/STANDARDS.md` as the binding coding standard, stating that it must
   be read in full before writing code.
4. A pointer to `docs/antigravity/README.md` for the delegation contract and the brief index.
5. The three commands that matter, exactly as they appear in `CLAUDE.md`:
   `pnpm test`, `pnpm lint`, `pnpm verify:arch`.
6. A short "never" list, pointing at STANDARDS.md §11 rather than restating it.

**Target length: under 60 lines.** If it grows past that, you are duplicating STANDARDS.md — stop
and point at it instead.

---

## Task 2 — Add the precedence block to four files

Insert this block **verbatim**, as a fenced code block preceded by a `## Precedence` heading, into:

- `GEMINI.md` (as part of Task 1)
- `AGENTS.md` — directly beneath the existing quote block at the top
- `CLAUDE.md` — directly beneath the `# FounderOS — Claude Instructions (v3)` heading
- `docs/antigravity/STANDARDS.md` — directly beneath the bold "Read this before writing code…" line

```
1. Founder instruction in chat                  ← always wins
2. CI fitness rules (verify-architecture.ts)    ← the only BINDING layer
3. docs/antigravity/STANDARDS.md                ← how code is written
4. CLAUDE.md / AGENTS.md / GEMINI.md            ← role-specific operating instructions
5. Everything else                              ← reference
```

Follow it in each file with exactly one sentence of your own: that a rule which is not enforced by
layer 2 is a convention, and a rule that is enforced cannot be satisfied by argument.

Do not reword the block per file. Identical text in all four is the point — it is how drift becomes
visible.

---

## Task 3 — Retire `.cursorrules`

Replace the **entire contents** of `.cursorrules` with a pointer file of at most 20 lines
containing:

- One line explaining that this file is intentionally a pointer, not a rulebook, because four
  competing sources of truth is what caused the drift being fixed here.
- The precedence block from Task 2.
- Links to `docs/antigravity/STANDARDS.md`, `AGENTS.md`, and `CLAUDE.md`.
- Nothing else. No rules, no git policy, no architecture notes.

Cursor requires the file to exist; it does not require it to be a fourth source of truth.

**Preserve nothing from the old contents.** Everything unique in it is either already in
`AGENTS.md`/`STANDARDS.md` or is the false claim in defect 1.

---

## Task 4 — Fix the stale count in `AGENTS.md`

In the "Running / testing" section, `~1100 tests` becomes `~2540 tests`. Change **only** that
number. Do not restructure, reformat, or otherwise edit `AGENTS.md` beyond this and the Task 2
insertion.

---

## Explicitly forbidden — task-specific

General rules are in [STANDARDS.md](STANDARDS.md) and apply in full. Task-specific:

- **Do not** modify any `.ts`, `.js`, `.json`, or `.yml` file. This task touches Markdown and
  `.cursorrules` only.
- **Do not** touch `scripts/verify-architecture.ts` or `governance/architecture-baseline.json` —
  another task owns them, and editing them here causes a conflict.
- **Do not** touch anything under `src/` or `tests/` — a third task owns `src/evolution/`.
- **Do not** edit `docs/antigravity/AG-001` … `AG-006` briefs, or `docs/founderos-v2/*`. They are
  historical records.
- **Do not** rewrite, condense, or "improve" the rest of `CLAUDE.md`, `AGENTS.md`, or
  `STANDARDS.md`. Your only edits to those three are the precedence insertion and the one number in
  Task 4.
- **Do not** create any file other than `GEMINI.md`.

---

## Verify

This task changes no code, so the verification is that it broke none:

```bash
cd /Users/pushkarverma/Projects/founderos && pnpm lint && pnpm verify:arch && ls -la GEMINI.md && wc -l GEMINI.md .cursorrules && grep -rn "branch-policy.yml" --include="*.md" --include=".cursorrules" . | grep -v node_modules
```

**Report its raw output in full.** Expected:
- `tsc --noEmit` silent.
- `verify:arch` green, every count at baseline.
- `GEMINI.md` exists, under 60 lines; `.cursorrules` at most 20 lines.
- The final `grep` returns **either nothing, or only matches inside `AGENTS.md` that describe the
  workflow's deletion as history** (that text is correct and must stay). It must return no line that
  asserts the workflow currently enforces anything.

If any part fails, fix it and re-run. Do not report the task complete with a failing verify.

---

## What happens next (do not do this yourself)

A human reads `git diff` in full and re-runs verify before this is accepted. Report the raw verify
output and stop — do not summarize the work as "done".
