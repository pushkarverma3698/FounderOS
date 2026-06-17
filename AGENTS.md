# AGENTS.md

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
- Redis / Ollama / Composio / Firecrawl / LangSmith are all **optional** — the app
  degrades gracefully without them. Don't treat them as blockers.

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
