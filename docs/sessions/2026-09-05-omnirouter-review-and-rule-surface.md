# 2026-09-05 — OmniRouter/OpenCode review + instruction-surface dedupe

## What we did

Two tracks, both closed in one session.

**Track 1 — land the token work and audit the repo's own rules.** Merged #606
(branch-naming gate) to `beta`, then found `beta` is 21 commits behind `main`, so
re-applied both #606 and #608 directly onto `main` as #611.

**Track 2 — adversarial review of `cursor/audit-omnirouter-opencode`.** Reviewed,
fixed what could be fixed cleanly, opened #610 with the findings that need a
decision.

## What we fixed

### Instruction surface (#608 → #611, merged)

| Finding | Evidence |
|---|---|
| Global `~/.claude/CLAUDE.md` carried a FounderOS-only Cost Control section | Every command it named (`pnpm eval`, `pnpm qa:telegram`, `scripts/probe-*.ts`, `e2e-telegram-qa.ts`) exists **only** in this repo — verified by sweeping every `~/Projects/*/package.json`. ~475 tokens/session billed to every project for rules that could not apply. Moved into this repo. |
| That block also pinned a **production** model | `openrouter:google/gemini-2.5-flash-preview-05-20` — matched neither this repo's `CLAUDE.md` nor `apply-prod-env-overrides.sh`. Deleted; global now names no slug ever. |
| Model policy mirrored the model chain into markdown | The doc said "keep this line and the script in sync" — no mechanism (rule #27). That exact drift is what left prod on a fully-dead OpenRouter fallback tail for weeks. Script is now the single source. |
| `Experience & Outcome Over Code Purity` was in `AGENTS.md` + `GEMINI.md` but **not** `CLAUDE.md` | The one agent that reviews the others was the only one unbound by it. In `AGENTS.md` the paste also split numbered list items 4 and 5. Now `SHARED-DIRECTIVES.md` #5. |
| Ollama stated in three places; dead in-file anchor; brain-sync rule restated 150 lines below itself | Consolidated. |

### OmniRouter branch (#610, draft — fixes pushed, findings open)

| Sev | Finding |
|---|---|
| **CRITICAL** | `DEFAULT_AGENT_MODEL` was changed to `omnirouter:auto/gemini` → `http://127.0.0.1:20128`. Measured: **laptop http=200, VPS http=000**. That constant is the *misconfiguration fallback*; the comment above it promises "Gemini Flash is the far safer failure mode". Reverted. |
| HIGH | `src/tools/opencode.ts` — 372 lines, **nothing imports `openCodeTool`**. Dead code. |
| HIGH | It is a copy-paste fork of `claude-code.ts`: both exactly 372 lines, **300 byte-identical**, all 62 differing lines are string swaps. |
| MEDIUM | Logged as `module: "tool:claude-code"` — every log line misattributed. Fixed. |
| MEDIUM | Four scratch files at repo root, incl. `rewrite_model.cjs`, a stale codemod from the vertex migration that no longer matches `model.ts`. Removed. |
| MEDIUM | Zero tests reference `omnirouter`. |
| LOW | `npm install -g … opencode-ai 2>/dev/null \|\| true` on the VPS — a failed install still reports deploy success. |

**OmniRouter itself works.** Live-verified tool-calling: `auto/gemini` → `gemini-3.6-flash`,
proper `tool_calls` delta, 74 ms. The provider premise is sound; only the *default* was wrong.

## Why

**Green CI did not catch the critical defect, and the reason generalises.** The guard test is
`returns an OpenRouter-backed ChatOpenAI model by default` — and `omnirouter:` also constructs a
`ChatOpenAI`. The test asserts the **class**, not reachability, so it passed throughout. A test
that pins a type cannot detect a change of endpoint.

**The brain is not unified, and this branch is not the work that would unify it.** Measured:

| | Reality |
|---|---|
| Brain server on the VPS | **None.** Listening: Postgres (localhost-only), Ollama, nginx, node:3001 |
| What the IDEs read | `turicks-brain-rag` — a **71 MB local Chroma dir on the laptop**. `grep -rlE "psycopg\|postgres" src/` → nothing |
| What `pnpm brain:sync` writes | the `turicks_brain` **pgvector table in Postgres** |
| Cursor | no brain MCP configured at all |

So two brains that never meet: sync writes Postgres, IDEs read Chroma. **Restarting the IDEs
cannot connect anything to the VPS, because no VPS brain is listening.**

## Metrics

- Always-loaded instruction surface: **83,400 → 80,795 chars** (~20,850 → ~20,199 tokens/session, **−651**)
- `beta` behind `main`: **21 commits** — `sync-beta` is not closing the gap
- `opencode.ts` vs `claude-code.ts`: 372/372 lines, 300 identical, 62 differing (all string swaps)
- PRs: #606 ✅ beta · #608 ✅ beta · **#611 ✅ main** · #610 draft (3/3 CI green, BEHIND)

## Outstanding

1. **#610 needs a decision, not a patch** — wire `openCodeTool` or delete it; and if it stays,
   parameterize `claude-code.ts` instead of maintaining a fork. Left as a draft because
   Antigravity is actively working and one writer holds a branch at a time.
2. **`beta` is 21 commits behind `main`.** Until `sync-beta` is fixed, every PR opened against
   `beta` inherits a stale base and conflicts unrelated to its own change. This session hit it
   twice.
3. **No VPS brain exists.** If "one always-on brain across every IDE" is the goal, the binding
   constraint is that nothing is listening — not model routing. Smallest real step: serve the
   brain over the network from the VPS and point every IDE's MCP at it.
4. `MEMORY.md` is 19,106 chars (~4,776 tokens/session), the largest remaining always-loaded item
   after global `CLAUDE.md`. ~40% is 2026-06/07 history already marked superseded.

## Gotcha worth keeping

`cmd 2>&1 | tail -N` exits with **tail's** status, always 0. Three gate runs in this session
reported a false green that way. Always `cmd > log 2>&1; echo $?`.
