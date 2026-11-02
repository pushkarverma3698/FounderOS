# Integration Testing Rules

## The Rule

Every tool addition or modification **must** include an integration test.
No integration test → PR is blocked (enforced by CI job `integration-tests`).

## What Counts as an Integration Test

A test that:
1. Calls the **real tool function** (e.g., `sendEmail`, `searchWeb`, `githubRead`)
2. Uses real dependencies at the boundary — mocked external HTTP/API, but real internal code
3. Verifies the **response contract** (shape, required fields, error structure)
4. Tests the **error path** (API down, auth failure, invalid input)
5. Tests the **soft-failure path** (tool returns `{success: false}` without throwing)

Tests that only call mock implementations of the tool itself do NOT count as integration tests.

## File Location

```
tests/integration/{tool-name}.test.ts
```

Examples (illustrative naming; these files do not exist today, the real ones are listed in `tests/integration/`):
- `tests/integration/send-email.test.ts`
- `tests/integration/github-read.test.ts`
- `tests/integration/search-web.test.ts`
- `tests/integration/run-command.test.ts`

## Minimum Test Cases Per Tool

| Test case | Required? |
|-----------|-----------|
| Happy path — correct input, expected output shape | Yes |
| Missing API key — tool errors loudly, not silently | Yes |
| External API 500 — tool returns `{success: false}`, does not throw | Yes |
| Idempotency key — second call with same key is skipped (for HITL-gated tools) | If tool has idempotency |
| Path guard / input validation rejection | If tool has input validation |

## Running Integration Tests

```bash
# All integration tests
pnpm test:integration

# Single file
npx vitest run tests/integration/send-email.test.ts
```

Integration tests require API keys. In CI they run only when `GOOGLE_GENERATIVE_AI_API_KEY` is set.
Locally: `source .env && pnpm test:integration`.

## What Integration Tests Are NOT

- Do NOT run the whole jobs pipeline — that is an E2E check (use `scripts/telegram-probe.ts`; `probe-real-task.ts` was removed 2026-10-10)
- Do NOT require a live Telegram bot
- Do NOT require Postgres unless the tool itself requires it

## Adding a Tool — Checklist

Before merging a PR that adds or modifies a tool:

- [ ] Unit test covers pure logic (input parsing, path guards, output format)
- [ ] Integration test covers the real function call + error path
- [ ] `pnpm test` green (unit + integration)
- [ ] `pnpm lint` clean
- [ ] Tool is wired where the jobs pipeline calls it (`src/tools/` implementation + its caller under `src/jobs/` or `src/gateway/`). The kernel wiring layers (`agent-tools.ts`, `capabilities.ts`, `prompts/<dept>.ts`) were removed 2026-10-10

## Why This Rule Exists

The most damaging bugs in FounderOS history all had unit tests passing while production failed:
- Wedged interrupt loop (unit tests bypassed the gateway)
- Duplicate bot instances (no process-level test)
- Composio phantom-success (mock only covered happy path)

Integration tests at the function boundary catch the layer above unit tests and below E2E.
They are the cheapest tests that can catch "the wiring is broken" bugs.
