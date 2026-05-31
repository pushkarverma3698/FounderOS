# Contributing to FounderOS

Thanks for your interest. FounderOS is a multi-agent operating system built on
Node.js 22 + TypeScript (strict) + LangGraph. This guide gets you productive fast.

## Setup

```bash
pnpm install
cp .env.example .env          # fill in at least one LLM provider key + Telegram
cd docker && docker compose up -d postgres redis
npx tsx scripts/setup-db.ts   # applies migrations + LangGraph checkpoint tables
pnpm test                     # everything mocked/local — should be green
npx tsx src/index.ts          # start the bot
```

Only one LLM provider key is strictly required (Google/Anthropic/OpenRouter/OpenAI).
With just a Google (Gemini) key the whole system runs — the cascade falls back to
free OpenRouter models where configured.

## Ground rules (see `CLAUDE.md` for the full list)

1. **Registry-driven** — never hardcode company/agent names outside `src/core/registry.ts`.
2. **Graph compiled once** — use `getGraph()`; never compile inside a handler.
3. **Idempotency before external sends** — check `hasBeenAudited()` first.
4. **HITL is DB-backed** — write to the registry before calling `interrupt()`.
5. **Different model families for generator vs critic** — prevents sycophancy.
6. **Zod at the boundary** — validate env + external responses.

## Tests

- `pnpm test` runs the mocked/local pyramid (unit, integration, chaos, load, e2e).
- Live suites (`tests/live/**`) hit real providers/Ollama and cost money — run them
  deliberately, not in CI by default.
- Add a failing test before fixing a bug (TDD). `pnpm test` must be green before a PR.

## Live test harness

`scripts/ceo-live-battery.ts` drives the compiled graph with real CEO tasks against
the cloud cascade under a hard budget cap. See `docs/PRODUCTION-READINESS.md` for the
methodology and latest results.

## Pull requests

- Conventional commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`).
- Keep PRs focused; one concern each.
- Update the relevant doc in `docs/` in the same PR when behavior changes.
