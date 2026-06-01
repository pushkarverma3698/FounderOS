# FounderOS v2 — "One agent, real tools, real actions"

**Date:** 2026-06-01
**Status:** Approved design — ready for implementation planning
**Branch:** `feat/v2-react-agent` (clean cut; `main` untouched until merge)

---

## 1. Problem (why v2 exists)

The v1 system is 10,678 LOC of routing, an 8-tier model cascade, critics, circuit
breakers, a token economy, and multi-tenancy wrapped around a core loop that —
for **4 of 5 departments** — ends at `writeAuditEntry()` instead of
`tool.execute()`.

Evidence from the architecture audit (2026-06-01):

- `src/agents/pods/sales.ts:281` — `finalizeNode` audits but **never calls `emailTool`**.
- `src/agents/pods/engineering.ts:154` — `qaTester` is a `passed:true` stub; **`githubTool` never called**.
- `src/agents/pods/social.ts:249,260` — the only real tool call; falls back to a fake `dry-run-{ts}` post id.
- `src/core/registry.ts:104-191` — `allowed_tools` arrays (`firecrawl`, `write_file`, `pytest`…) are **fiction**; nothing reads them and names don't match the 6 real tools in `src/tools/index.ts`.

The tools (web-search, email, github) are real and good and **wired to nothing.**
The system is not over-engineered relative to a hard problem — it's
over-engineered relative to a problem it never actually solved.

## 2. Goal

A **single-user** tool that does **real work reliably** (Pushkar runs Turicks +
Naggar from Telegram), written as **idiomatic, portfolio-grade LangGraph JS.**
Shippable in one week.

**Explicitly NOT this week:** multi-tenant SaaS, billing, auth, onboarding.
`tenant_id` survives as a column only so the SaaS pivot later is not a rewrite.

### Success criteria (measurable)

1. A Telegram message → web research returns a real, cited summary.
2. "Email X about Y" → draft → Telegram **Approve** → an email **actually lands in an inbox**.
3. "Open a GitHub issue / push a fix" → draft → Approve → the issue/PR **actually appears** on GitHub.
4. Rejecting an approval results in **no external action** and an honest reply.
5. No code path produces "✅ Task processed (no output)" or a raw JSON dump in Telegram.
6. `pnpm test` green; `npx tsc --noEmit` clean; total `src/` LOC < 2,500.

## 3. Architecture

One ReAct agent. The model sees the user message + tool schemas and decides what
to call. No pre-router, no CEO supervisor, no keyword department resolver, no pod
subgraphs.

```
Telegram message
  → ReAct agent (Gemini Flash + tools + Postgres checkpointer)
      → model reasons: which tool?
      → READ-only tool (web_search)         → runs immediately
      → WRITE tool (email / github / linkedin)
            → interrupt() → Telegram approval card
                 → Approve → SAME tool node executes the real action → result to Telegram
                 → Reject  → agent told "user declined" → honest reply
```

### Target file tree (~12 files, < 2,500 LOC)

```
src/
  index.ts            boot: telemetry → agent → telegram → scheduler
  agent.ts            createReactAgent({ llm, tools, checkpointer })
  llm.ts              1 primary (Gemini Flash) + 1 fallback        (~70 LOC, was 826)
  prompts.ts          ONE system prompt: identity, businesses, tools (~120 LOC, was 983)
  tools/
    web-search.ts     KEEP — read-only, no approval
    email.ts          KEEP — approval + suppression + daily cap + idempotency INSIDE the tool
    github.ts         KEEP — approval
    linkedin.ts       KEEP — approval; experimental if no write scope
    index.ts          tool registry (real names only)
  gateway/
    telegram.ts       message → agent.stream; on interrupt → approval buttons → resume
  db/
    schema.ts         audit_log, do_not_contact (+ langgraph checkpoint tables)
    queries.ts        named queries only
  infra/
    checkpointer.ts   KEEP — Postgres saver (also gives crash-safe HITL for free)
    telemetry.ts      KEEP trimmed — LangSmith init
    logger.ts         KEEP — pino
    scheduler.ts      KEEP trimmed — only jobs that fire real actions (else delete)
```

## 4. The agent (`agent.ts`)

```ts
import { createReactAgent } from "@langchain/langgraph/prebuilt";

export async function getAgent() {
  const checkpointer = await getCheckpointer();
  return createReactAgent({
    llm: getModel(),                 // Gemini Flash (env-swappable to Claude)
    tools: [webSearch, sendEmail, githubTool, linkedinPost],
    checkpointer,
    stateModifier: SYSTEM_PROMPT,    // single founder-context system prompt
  });
}
```

Compiled once at startup, reused forever (existing rule #2 preserved).

## 5. HITL — the part that must be perfect

The v1 failure was: approval led to an audit log, not an action. v2 makes the
**tool itself** the thing that runs on resume, so "approve → nothing" is
structurally impossible.

- Read-only tools (`web_search`) never interrupt.
- Write tools call LangGraph native `interrupt({ tool, args, summary })`. The
  graph pauses (checkpointed = crash-safe). Telegram renders an Approve/Reject card.
- **Approve** → `Command({ resume: "approved" })` → the same tool node executes the real action.
- **Reject** → `Command({ resume: "rejected" })` → tool returns "declined by user"; the agent replies accordingly.

This replaces the entire v1 `hitl.ts` (236 LOC) + `hitlApprovals` table lifecycle.
The Postgres checkpointer already persists thread state, so crash-recovery is free.

## 6. Tools (the actual product — kept and finally wired)

| Tool | Approval? | Notes |
|------|-----------|-------|
| `web_search` | No (read-only) | Firecrawl/Tavily. Fixes "research X → silence". Needs `FIRECRAWL_API_KEY`. |
| `send_email` | **Yes** | Composio Gmail. Safety rails live INSIDE the tool (see §7). Needs Composio Gmail auth. |
| `github` | **Yes** | Octokit `create_repo`/`create_issue`/`update_readme`. Needs `GITHUB_TOKEN`. |
| `linkedin_post` | **Yes** | Composio `w_member_social`. Marked experimental if write scope absent (no fake dry-run id — it reports honestly). |

Tool names in the registry are the **real** names. No `allowed_tools` fiction.

## 7. Safety rails — moved from graph nodes into the tools

The v1 suppression/quota nodes guarded drafts that never sent. v2 moves them
**inside `email.ts`**, executed immediately before the real send:

1. `do_not_contact` lookup — recipient suppressed → abort with a clear reason.
2. Daily send cap — Postgres counter per day (Redis not required for one user).
3. Idempotency — `audit_log` key `email:{hash}` — already sent → skip (no double-send).

Same protection, ~1/10th the code, and it actually guards the real action.

## 8. Model strategy (`llm.ts`)

- **Primary:** `gemini-2.5-flash` (cheap, fast, good tool-calling, 1M context; works with the existing Google key today).
- **Fallback:** one entry — `gemini-2.5-pro` or `openrouter/llama-3.3-70b:free`.
- **Claude-later:** primary model id read from one env var (`AGENT_MODEL`); when a
  valid Anthropic key is added, flip the var to `claude-sonnet-4-5` — no code change.
- Delete: 8 cascade tiers, per-tier token tables, the `runToolExecutor` two-phase
  local-model dance, opossum circuit breakers, bottleneck rate limiter.

## 9. Data model — 3 tables

- `audit_log` — real: email/github idempotency + a record of every external action taken.
- `do_not_contact` — real: suppression list for email.
- LangGraph checkpoint tables — managed by the Postgres saver.

**Dropped tables:** `deptSignals`, `knowledgeEntries`, `agentResults`, `outboundLeads`
(pipeline CRM is out of scope for week 1), `aiCallCosts` (LangSmith covers cost
observability). `tenant_id` stays as a column on `audit_log`/`do_not_contact`.

## 10. Error handling

Every failure surfaces to Telegram as a readable message — never a silent audit
row, never raw JSON.

- Tool error → agent observes it and tells the user what failed and why.
- LLM error → one fallback model, then an honest "couldn't reach the model, retry".
- Unknown/odd input → the agent just answers conversationally (ReAct handles this natively; no "unroutable" dead-end exists anymore).

## 11. Testing

8–10 integration tests against the real loop with tool HTTP mocked:

1. message → `web_search` → reply contains the searched content.
2. message → email draft → interrupt fired → approve → `send_email` HTTP called once.
3. same → reject → `send_email` HTTP **never** called.
4. idempotency — same email twice → second is skipped.
5. suppression — recipient in `do_not_contact` → send aborted.
6. github → approve → `create_issue` called.
7. read-only tool never triggers an interrupt.
8. LLM primary fails → fallback used.

Plus unit tests for the in-tool safety rails (suppression, daily cap, idempotency).

## 12. Migration / rollout

- Branch `feat/v2-react-agent` off current. `main` untouched until merge.
- Old orchestration deleted outright (recoverable via git history).
- Existing infra reused as-is: `checkpointer.ts`, `logger.ts`, drizzle client,
  `telemetry.ts` (trimmed), the 4 tool files.
- Human-only merge (existing rule preserved).

## 13. Five-day plan

| Day | Outcome |
|-----|---------|
| 1 | New branch. `createReactAgent` + 4 tools stood up. One message → one real tool round-trip green in a test. |
| 2 | Native HITL → Telegram. **Verify a real email lands + a real GitHub issue opens.** (Stops being fake.) |
| 3 | Collapse `llm.ts` to 1+1 model. Delete cascade/circuit-breakers/rate-limiter. Trim DB to 3 tables. |
| 4 | Rewrite system prompt. Move safety rails into `email.ts`. Re-add LangSmith tracing. |
| 5 | Per-user thread isolation (`thread_id={userId}:{chatId}`). Error surfacing. Integration tests. Docs match reality. |

## 14. Risks & mitigations

- **Big delete in a week.** Deletion is fast and safe (little working behavior to
  break). The only hard day is Day 2 (HITL → real execution), which gets dedicated focus.
- **LinkedIn write scope may be absent.** Tool reports honestly instead of faking a
  post id; LinkedIn stays "experimental" without blocking the ship.
- **Composio/Firecrawl keys may be unset.** Each tool fails loudly with a clear
  "set KEY in .env" message; the rest of the agent still works.

## 15. Self-critique (per CLAUDE.md rule #12)

1. *"A single ReAct agent loses the multi-agent planning quality."* — There is no
   validated quality to lose: v1 pods produced drafts that were never sent, so
   their planning was never tested by a real outcome. ReAct + a good prompt is the
   correct baseline; add a reflection step only if real output quality proves
   insufficient.
2. *"Deleting the cascade/tenancy kills the SaaS story."* — No. `tenant_id` stays a
   column and the model id is env-swappable. The SaaS story requires a tool that
   works for ONE user first; you cannot sell a system that drafts emails and never sends them.
3. *"5 days is tight for a 6k-line delete + rewire."* — Deletion can't break working
   behavior (there's little of it). The rewire risk is concentrated in Day 2 and isolated there.
