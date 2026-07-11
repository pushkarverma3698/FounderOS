# Contributing to FounderOS

FounderOS is a deterministic agent kernel with a Telegram gateway — Node 22 +
TypeScript (strict) + LangGraph StateGraph + grammy + drizzle/Postgres. This
guide gets you productive fast. **AI agents working on this repo must also read
[`agent-rules.md`](agent-rules.md) — it is the binding contract.**

## Setup

```bash
pnpm install
cp .env.example .env                                  # one LLM provider key + Telegram
docker compose -f deploy/stack.compose.yml up -d postgres   # add `ollama` for local embeddings
pnpm db:migrate                                       # drizzle migrations
pnpm test                                             # scripted models, $0 — must be green
pnpm dev                                              # start the bot (long-polling)
```

## Architecture in one line

```
message → plan (LLM) → dispatch (pure) → agent ⇄ tools → collect (pure) → … → synthesize (LLM) → reply
```

Contracts (`src/kernel/contracts.ts`) ARE the architecture: every boundary is
Zod-validated; a mismatch is a terminal, typed FailureReport — never
retry-and-hope. Read `JARVIS-ARCHITECTURE.md` before touching the kernel.

## Ground rules (full list in `CLAUDE.md` + `agent-rules.md`)

1. **Import direction** — contracts ← kernel ← gateway; kernel imports only
   kernel/core/db/infra/tools. CI-enforced (`pnpm verify:arch`).
2. **HITL ordering** — DB row BEFORE `interrupt()`; side effects only after
   approval; idempotency key check before every external send.
3. **Determinism** — temp 0; routing/parsing/guards are pure unit-tested
   functions, never prompt instructions.
4. **Zero-hallucination** — action claims require successful ToolReceipts;
   the synthesizer sees only validated results.
5. **Fix the schema, not the code** — ambiguous requirements → the planner
   asks for the missing field; never guess data.
6. **Bug fixes start with a failing test** (PR template enforces this).

## Tests & cost zones

| Zone | Command | Cost |
|------|---------|------|
| Dev loop | `pnpm test` (scripted models) | $0 — a real LLM call in a unit test is a bug |
| Merge gate | `pnpm gate` (lint+build+wiring+arch+test) | $0 |
| Milestone | `pnpm eval` (live golden set) | paid — once per feature, not per attempt |
| Acceptance | `pnpm qa:telegram` (22-task MTProto simulation) | paid — once, pre-release |

## Pull requests

- Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- Keep PRs focused; one concern each.
- Evidence in every PR: fresh `pnpm gate` output + live-path proof, or an
  explicit **NOT VERIFIED** with the reason.
- Update the relevant doc in `docs/` in the same PR when behavior changes,
  then `pnpm brain:sync`.

### Branch model (stable / beta / main)

Production deploys from **`main`** only. All feature work integrates on **`beta`** first.

```
feat/* → PR → beta → PR → stable → PR → main (CD deploy)
```

1. Open PRs to **`beta`** — CI + branch-policy workflow must pass.
2. Only the founder merges **`beta` → `stable`** and **`stable` → `main`**.
3. Never commit to `main` directly. Only humans merge.

Full runbook: [`docs/process/BRANCH-MODEL.md`](docs/process/BRANCH-MODEL.md).

## Production ops

- Deploy: CD on merge to `main` → systemd `founderos.service` on the VPS.
- Backups: `deploy/backup-db.sh` (nightly cron, 14-day retention).
- Self-healing: `deploy/watchdog.sh` (cron every 2 min — restarts a hung bot
  via systemd, Telegram-alerts only on unrecoverable failure).
- Health: `GET :3001/health`, metrics on `/metrics`.
