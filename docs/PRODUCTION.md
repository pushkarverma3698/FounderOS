# FounderOS — Production Runbook

> Single-operator runbook for the live Telegram bot. FounderOS today is a
> **single-tenant, single-instance** service (one founder, one process behind a
> PID lock). Multi-tenant SaaS concerns (per-user limits, on-call rotation,
> blue-green) are **Phase-E** and intentionally out of scope — see
> [`ROADMAP.md`](ROADMAP.md) and the
> [hardening triage](PRODUCTION-HARDENING-TRIAGE-2026-06-12.md).

---

## 1. What runs, and how

- **Entry:** `src/index.ts` → `initTelemetry()` → compile office (`getOffice()`) →
  `startBot()` (grammy long-poll). A PID-file lock
  (`src/infra/single-instance.ts`) guarantees exactly one process; a second start
  waits for the first to exit (`waitForProcessExit`) before binding.
- **Run loop:** `src/gateway/office-run.ts` — `runOfficeText` (messages) and
  `resumeOffice` (approval taps). The three thread guards (stale-approval, wedge,
  history-trim) live here and are unit-tested in `tests/unit/gateway/`.
- **Persistence:** Postgres via the LangGraph checkpointer (per-chat thread
  `"<tenant>:<chatId>"`) + the `action_log` audit table. State survives restarts.
- **Start / restart (safe, lock handles drain):**
  ```bash
  npx tsx src/index.ts            # foreground
  # or background with the project's process manager; the lock makes restart safe
  ```

---

## 2. Kill switch (global halt)

The one-command emergency stop. Backed by a **flag file** (presence = halted),
not Redis — no boot dependency, can't fail-open. See `src/infra/halt.ts`.

| Action | How |
|--------|-----|
| **Halt** | Telegram: `/halt <reason>` (reason optional) |
| **Resume** | Telegram: `/resume` |
| **Out-of-band halt** | `touch "$HOME/.founderos/HALT"` (or write JSON `{reason,engagedAt,by}`) |
| **Out-of-band resume** | `rm -f "$HOME/.founderos/HALT"` |
| **Path override** | env `HALT_FLAG_PATH` |

**What it guarantees:** while halted, **every new turn AND every approval resume is
refused at gateway entry** before any office work or side effect runs — no email,
LinkedIn post, GitHub write, or file write can execute. The refusal is traced as the
`halt.blocked` seam and the founder gets a clear notice.

**What it does NOT do (not overclaimed):** it does not abort a task already mid-run.
Turns are seconds-long and the per-run budget guard (`src/infra/budget.ts`) caps
runaway loops, so a turn-entry check is the pragmatic stop for a single-instance bot.
To stop an in-flight run, halt **and** restart the process (state is checkpointed —
no data loss).

**Verify it works:** `/halt test` → send any message → you should get the 🛑 notice
and see a `halt.blocked` line in the log under that turn's `turnId`, with **no**
`action_log` row written. Then `/resume` and confirm normal processing.

---

## 3. Monitoring & observability

- **Per-turn trace:** every inbound turn gets one `turnId` and an ordered list of
  seams (`turn.in → route.decided → tool.call/result → hitl.* → turn.out`). To read
  a whole turn: `grep <turnId> /tmp/founderos.log`. Source: `src/infra/trace.ts`.
- **LangSmith:** enabled when `LANGCHAIN_TRACING_V2=true` + `LANGCHAIN_API_KEY` set;
  project `LANGCHAIN_PROJECT` (default `founderos`). PII is scrubbed in
  `src/infra/telemetry.ts` before export.
- **Health:** `src/infra/health.ts` serves `/health` and `/metrics`.
- **What to watch:** repeated `turn.error` seams, `wedge.recovered` frequency,
  budget-summary log lines (`Run complete — budget summary`), and any `409` from
  Telegram (means a duplicate bot instance — the PID lock should prevent it).

---

## 4. Cost / budget controls (already live)

Per-run caps are enforced **before the run completes** via `BudgetGuardCallback`
(wired into both invoke sites in `office-run.ts`). A run that exceeds the cap throws
`BudgetExceededError` and surfaces to the founder rather than draining spend.

| Env var | Default | Meaning |
|---------|---------|---------|
| `RUN_BUDGET_USD` | `0.50` | Max USD per single office run |
| `RUN_BUDGET_TOKENS` | `50000` | Max tokens per single office run |
| `BUDGET_DAILY_USD` | `5.0` | Daily spend reference cap |
| `OFFICE_RECURSION_LIMIT` | `40` | Max supervisor/sub-agent steps before abort |

Pricing table lives in `src/infra/budget.ts` (`MODEL_COSTS`) — update when a
provider changes rates.

---

## 5. Disaster recovery

- **State store:** Postgres (checkpointer + `action_log`). Take regular Postgres
  backups (`pg_dump`) per your DB host's schedule; that is the recovery point.
- **Crash / restart:** the single-instance lock drains the old process
  (`waitForProcessExit`, SIGKILL on timeout) then the new one binds. Checkpointed
  threads resume cleanly; a thread left mid-graph is auto-recovered by the wedge
  guard (`recoverWedgedThread`) on the next message.
- **Wedged thread (manual):** if a chat loops or repeats a stale reply, `/reset`
  clears that chat's checkpoints.
- **Invalid checkpoint:** `resumeOffice` validates messages before re-invoking
  (`assertNonEmptyMessages`) and tells the founder to `/reset` if state is corrupt —
  it never feeds bad state to the model.

---

## 6. Required environment

Validated at startup by the Zod schema in `src/core/config.ts` — the process
**fails fast** with a clear message if a required var is missing or malformed.
Required: `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Strongly
recommended: `GOOGLE_GENERATIVE_AI_API_KEY` (primary model). See
[`.env.example`](../.env.example) for the full annotated list.

---

## 7. Escalation

Single founder-operator. There is no on-call rotation by design (single-tenant).
P1 = bot down or acting without approval → `/halt`, then restart. If a secret is
suspected exposed → rotate the key with the provider immediately and restart.
