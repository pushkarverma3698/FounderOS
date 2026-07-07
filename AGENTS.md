# AGENTS.md

## Engineering principle — reason before code

Every change must answer **why** before **what**:

1. **Name the problem** — What fails today? What breaks if we don't act?
2. **Name the stable boundary** — What should NOT change when a vendor/SDK drifts? (Usually: tool names, HITL gates, idempotency, department wiring.)
3. **Minimize blast radius** — Prefer an adapter/env flag over rewriting tools, prompts, or graph structure.
4. **Prove the real path** — Unit tests mock the provider dispatch layer; prod claims need boot probes or live evidence.

**Integration rule (ADR-029):** Tools call `src/infra/providers/` — never Composio, gws, or platform REST directly. Swap `GMAIL_BACKEND`, `LINKEDIN_BACKEND` via env; departments unchanged.

---

## Git / PR policy (non-negotiable — prevents "not mergeable")

**Cloud agents and Cursor must NEVER open PRs targeting `main`.** CI enforces this in
`.github/workflows/branch-policy.yml` — PRs to `main` are rejected unless the head
branch is exactly `stable`.

### Correct flow

```
cursor/* or feat/*  →  beta  →  stable  →  main (founder merges only, CD deploys)
```

| Action | Rule |
|--------|------|
| Cut branch from | `stable` (fetch + pull first) |
| Open PR to | **`beta`** always |
| Merge to `main` | **Founder only** via `stable → main` promotion PR |

### When creating a PR

```bash
git fetch origin stable && git checkout stable && git pull origin stable
git checkout -b cursor/my-task-d523
# … work …
git push -u origin cursor/my-task-d523
gh pr create --base beta --head cursor/my-task-d523 --draft --title "feat: …"
```

**Wrong:** `--base main` → Branch policy check **FAILS** → PR shows "not mergeable".

**Right:** `--base beta` → CI + branch policy pass → founder promotes later.

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
- Tests are keyless: `pnpm test` (vitest, ~1100 tests). Lint: `pnpm lint` (tsc --noEmit).
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
