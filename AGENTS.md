# AGENTS.md

> **Writing code in this repo?** `docs/antigravity/STANDARDS.md` is binding: purity and I/O
> placement, resolved-specifier reachability, named constants, loud-over-silent failure handling,
> test discipline, and the CI hard gates. This file covers git policy and environment; that one
> covers how the code is written. Read it before the first edit, not after a review.

## Precedence

```text
1. Founder instruction in chat                  ← always wins
2. CI fitness rules (verify-architecture.ts)    ← the only BINDING layer
3. docs/antigravity/STANDARDS.md                ← how code is written
4. CLAUDE.md / AGENTS.md / GEMINI.md            ← role-specific operating instructions
5. Everything else                              ← reference
```

A rule which is not enforced by layer 2 is a convention, and a rule that is enforced cannot be satisfied by argument.

Layer 5 reference material lives in [`docs/rules/`](docs/rules/) — notably the 8-point new-tool
checklist in `TOOL-STANDARDS.md`, plus `PROGRAMMING-RULES.md`, `TESTING-RULES.md` and
`TEST-PYRAMID.md`. `.cursorrules` used to be the only pointer to them; it is now a pointer file,
so this is.

## Engineering principle — reason before code

Every change must answer **why** before **what**:

1. **Name the problem** — What fails today? What breaks if we don't act?
2. **Name the stable boundary** — What should NOT change when a vendor/SDK drifts? (Usually: tool names, HITL gates, idempotency, department wiring.)
3. **Minimize blast radius** — Prefer an adapter/env flag over rewriting tools, prompts, or graph structure.
4. **Grounding & Memory-First Reasoning** — Reason strictly over repo data, DB memory (`founder_context`, `turicks-brain`, `failure_lessons`), and live code. Never use ungrounded world assumptions to overcomplicate tasks.

## Experience & Outcome Over Code Purity (⚠️ NON-NEGOTIABLE)
- The primary metric for FounderOS is **Founder Friction Saved & Real-World Outcome Quality**—not abstract code aesthetics or theoretical refactoring.
- Every self-improvement cron and audit must analyze 3 days of real turn transcripts, user feedback, hallucination signatures, and execution friction, storing findings into `failure_lessons` and `turicks-brain`.

5. **Prove the real path** — Unit tests mock the provider dispatch layer; prod claims need boot probes or live evidence.

**Integration rule (ADR-029):** Tools call `src/infra/providers/` — never Composio, gws, or platform REST directly. Swap `GMAIL_BACKEND`, `LINKEDIN_BACKEND` via env; departments unchanged.

---

## Git / PR policy (non-negotiable — prevents "not mergeable")

**Open your PRs against `beta`, not `main`.** `beta` is the integration branch: it
is where a change is proven before production sees it. This is a working
convention, no longer a CI gate — `.github/workflows/branch-policy.yml` was
deleted on 2026-08-01 (founder directive) because the ladder was blocking
finished work behind a human click while prod ran stale code.

### Correct flow

```
cursor/* or feat/*  →  beta  →  main (CD deploys)
```

| Action | Rule |
|--------|------|
| Cut branch from | `beta` (fetch + pull first) |
| Open PR to | **`beta`** always |
| Merge to `main` | Allowed, via a `beta → main` promotion PR, once CI is green |
| Merge on red CI | **Never.** Branch protection on `main` still requires both checks |
| After merging to `main` | **Verify the deploy landed.** A merge is not a deploy |

### When creating a PR

```bash
# 1. Start clean: pull latest beta and checkout your branch
git fetch origin beta && git checkout beta && git pull origin beta
git checkout -b cursor/my-task-d523

# 2. ... perform work ...

# 3. Before pushing, merge latest beta back into your branch to prevent "out-of-date" status
git fetch origin beta && git merge origin/beta

# 4. Verify all typechecks, compilations, and tests pass locally
pnpm gate

# 5. Push the branch
git push -u origin cursor/my-task-d523

# 6. Create the PR non-interactively (always specify base, title, and body)
gh pr create --base beta --head cursor/my-task-d523 --draft --title "feat: ..." --body "PR Description"
```

**Wrong:** `--base main` or ignoring out-of-date base branch drift → CI/branch policy blocks it.

**Right:** Merge `beta` locally first, run `pnpm gate`, and specify `--body` to open the PR cleanly.

See `docs/process/BRANCH-MODEL.md` for the full ladder.

---

## Cursor Cloud specific instructions

This section captures non-obvious, durable setup/run caveats for FounderOS in the
Cursor Cloud VM. Standard commands live in `README.md` and `package.json` scripts —
this only records the gotchas.

### Services
- **PostgreSQL** is the only hard dependency for tests/boot. It is installed
  **natively** in the VM (no Docker here), with the `pgvector` extension (the
  Drizzle migrations run `CREATE EXTENSION vector`). Role/db are `founderos`/`founderos`,
  matching the `DATABASE_URL` in `.env`.
- Postgres does **not** auto-start on VM boot. Start it before running setup/tests/app:
  `sudo pg_ctlcluster 16 main start` (idempotent enough — it no-ops/errors harmlessly if already up).
- Redis / Ollama / Firecrawl / LangSmith are all **optional** — the app
  degrades gracefully without them. Don't treat them as blockers.
- **gws** (Google Workspace CLI) is the default Gmail/Calendar backend (ADR-029).
  Optional in CI/tests (mocked). Install + `gws auth login` on prod VPS.
- **Composio** is legacy rollback only (`*_BACKEND=composio`). Not required for boot.

### Gotchas (these will bite you)
- **`pnpm setup` is NOT the DB setup script.** `setup` is a built-in pnpm command, so
  `pnpm setup` runs pnpm's own setup. Use **`pnpm run setup`** (drizzle migrations +
  LangGraph checkpointer tables; idempotent, safe to re-run).
- **The app cannot boot without a Gemini key.** `buildOffice()` constructs
  `ChatGoogleGenerativeAI`, which throws at startup if `GOOGLE_GENERATIVE_AI_API_KEY`
  is unset — even though `config.ts` marks it "optional in dev". Set it to run the app.
  (Any non-empty value lets the office graph compile + serve `/health`; a *valid* key is
  needed for real LLM routing.)
- **A bad Telegram token kills the process.** The bot long-polls on startup; an invalid
  `TELEGRAM_BOT_TOKEN` makes `getMe` return 401 and the polling crash calls
  `process.exit(1)` (fail-loud by design). The office compile + health server come up
  first, so a placeholder token still proves boot, but the process self-terminates ~1s
  later. Use a real BotFather token + `TELEGRAM_CHAT_ID` to keep the gateway alive.
- `.env` is gitignored. A dev `.env` is created with the local `DATABASE_URL`; fill in
  `GOOGLE_GENERATIVE_AI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` to run live.

### Platform integration defaults (ADR-029)
| Platform | Default | Env rollback | Prod auth |
|----------|---------|--------------|-----------|
| Gmail + Calendar | `gws` | `GMAIL_BACKEND=composio` | `gws auth login` on VPS |
| LinkedIn post | `direct` | `LINKEDIN_BACKEND=composio` | `LINKEDIN_ACCESS_TOKEN` + `LINKEDIN_AUTHOR_URN` |
| GitHub | Octokit | — | `GITHUB_TOKEN` |

### JARVIS cinematic UI (`apps/jarvis-next`) — **run on your machine**
- **One command:** `pnpm dev:jarvis-local` → UI **http://localhost:3000**, API **:3001**
- **Split:** `pnpm dev:jarvis-gateway` + `pnpm dev:jarvis-next`
- Do **not** rely on cloud VPS port forwarding for preview; run locally in your repo checkout.
- Needs Postgres + `GOOGLE_GENERATIVE_AI_API_KEY` in `.env`. Skips Telegram (no 409 with prod bot).

### Running / testing
- Tests are keyless: `pnpm test` (vitest, ~2540 tests). Lint: `pnpm lint` (tsc --noEmit).
  Build: `pnpm build:all` (backend `tsc` + `apps/jarvis` Vite). Dev run: `pnpm dev`.
  Health: `curl localhost:3001/health`.
- `pnpm eval` / `pnpm test:integration` need a **real** Gemini key + live Postgres.

### Pre-deploy (mandatory — do not skip, do not claim "ready" without evidence)
**A green `pnpm test` alone is NOT deploy-ready.** Type errors can hide behind
`tsx` dev mode; production runs compiled `dist/` via `pnpm start`.

Before merging to `main` or triggering deploy, run locally and paste/confirm output:

```bash
pnpm predeploy   # = lint + build:all + verify:wiring + test
```

| Step | What it catches |
|------|-----------------|
| `pnpm lint` | Type errors (no emit) |
| `pnpm build:all` | **Compile-time errors** — backend emit + JARVIS frontend |
| `pnpm verify:wiring` | Half-wired tools / registry drift |
| `pnpm test` | Regression + unit suite |

**Agent rule:** Never say "deployed" or "ready for prod" until `pnpm predeploy` is
green on the branch you are merging. CI and the deploy workflow both run `build:all`.
If you did not run it, label the claim **NOT VERIFIED**.

## Content Generation (No AI Slop)

**Mandatory Skill Usage:** Whenever you are generating, preparing, or drafting any content intended for public platforms (e.g., comments, posts, articles, social media, emails), you MUST use and strictly follow the `no-ai-slop` skill located at `/Users/pushkarverma/Projects/githubtools/no-ai-slop/SKILL.md`. 
**Why:** Nothing we publish on our platforms should look like AI-generated content. You must ensure all outputs are highly authentic, human-like, and completely free of typical AI "slop" (e.g., overly formal tone, unnecessary emojis, generic corporate speak, predictable structures).

## Implementation Plans & Memory

All implementation plans generated by Claude Code, Antigravity, or any agent MUST be saved with organized, descriptive filenames in the `docs/plans/` directory (e.g., `docs/plans/YYYY-MM-DD-feature-name.md`).
**Why:** Storing all plans centrally with semantic names drastically improves RAG retrieval, allowing future agents to intelligently learn from past architectural decisions and execution contexts. Do not store plans in scattered scratch directories or with generic names like `plan.md`.
