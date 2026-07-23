# FounderOS — Troubleshooting

Common failures and where to look. FounderOS surfaces failures as typed
`FailureReport`s with a `stage` and `component`, so the first move is always: **read
the failure — it names the real component.** For production operations, see
[guides/OPERATIONS.md](guides/OPERATIONS.md) and
[ops/RUNBOOK-PROD-NEVER-AGAIN.md](ops/RUNBOOK-PROD-NEVER-AGAIN.md).

## Reading a failure

A `FailureReport` tells you the stage. Map it to where to look:

| `stage` | Meaning | Look at |
|---------|---------|---------|
| `validation` | A contract didn't parse | The offending `schema_ref`; the planner or worker output |
| `planning` | The planner produced no valid plan | `src/kernel/planner.ts`; the model + prompt |
| `routing` | Dispatch couldn't route a step | The `worker` id in the envelope vs the worker registry |
| `tool` | A tool failed | The `component` field names it (composio, github, db, …) |
| `model` | Provider error | Status class (`src/agents/model.ts`); see below |
| `budget` | Cap hit | `RUN_BUDGET_USD` / `BUDGET_DAILY_USD`; `ai_call_costs` |
| `timeout` | Step/turn exceeded time | The slow tool; provider latency |
| `hitl_rejected` | You rejected the action | Expected — no side effect ran |

## Local dev

### `pnpm test` fails but I didn't touch that code
Run the full gate: `pnpm lint && pnpm verify:arch`. Most surprises are an
architecture rule, not a logic bug — e.g. a file crossed the **400-line budget**,
a **fail-open catch** lost its `// allow-failopen:` tag, or an import violated the
`gateway-imports`/`kernel-purity` direction. The verify output names the rule.

### "Tombstone" CI failure
You (or an agent) recreated a killed module (`pre-router`, `execution-guard`,
`office.ts`, `office-run`, a domain subgraph). That's intentional — don't rebuild
v2. Solve the problem inside the v3 pipeline instead. → [diagram
08](diagrams/08-anti-slop-ci-gates.md).

### Bot won't start locally
Check required env in `.env` (see [ops/ENV-VARS.md](ops/ENV-VARS.md)): at minimum
`DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
`GOOGLE_GENERATIVE_AI_API_KEY`. Missing required secrets fail loudly at boot by
design. Ensure Postgres is up (`docker compose up -d postgres`) and schema applied
(`pnpm setup`).

### `pnpm dev` reads the wrong chat / stale config
A stale local `.env` `TELEGRAM_CHAT_ID` is a known footgun — verify it matches the
intended chat.

## Runtime / production

### Model 401 / "no API key"
Direct Gemini needs `GOOGLE_GENERATIVE_AI_API_KEY`. A `401/403` is classified
**fail-loud** (not retried) — the key is missing or invalid. Rotate/set it; don't
expect fallback to mask it.

### Model 503 / 429 / transport errors
Classified **retriable** (`is503Error`); the fallback chain in
`src/agents/model.ts` engages (paid Gemini alternates, then free OpenRouter last
resort). Sustained failures = provider outage or quota — check
`ai_call_costs`/quota. A `404` triggers **model fallback** (the pinned model was
retired).

### "It replied "try again" / felt slow"
Historically this traced to model-provider quota throttling (calls falling to slow
free fallbacks), not kernel overhead. Check the model stage/component in the
failure and the cost ledger (`pnpm proof:costs`).

### An action didn't happen but the bot implied progress
By design the bot cannot claim an unbacked action (receipt requirement). If a
*send* stalled, look for a `tool`-stage failure naming the integration
(`component`), and confirm the `action_log` row was **not** written (no false
success).

### A thread seems "stuck" awaiting approval
There's a pending HITL interrupt. Approve or reject the card. Pending approvals are
durable across restarts; a stale card resolves as a clean no-op.

### I need to clear a thread
`/reset` is the **only** command that wipes a thread's checkpoints — by explicit
founder command. Nothing else deletes conversation state.

## Verifying a fix (rule #24)

"Done" means the verification command was run fresh with output shown. For kernel
changes, exercise the real path: `pnpm gate` (lint + build + wiring + arch + test,
all $0), then the live probe only at the milestone (`pnpm eval` / `pnpm
qa:telegram`). Unverifiable ⇒ say "NOT VERIFIED — reason."
